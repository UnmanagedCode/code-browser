import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { PROTOCOL } from './proxyProtocol.js';
import { ensureSecret, readHost } from './proxyStore.js';

// The wire client for the CDP proxy (proxy/cdp_proxy.py): newline-delimited JSON frames over raw TCP and a
// mutual HMAC challenge-response on every connection (the secret itself never crosses the wire). Each
// authenticated connection names one port and is then a byte pipe to 127.0.0.1:<port> on the Docker host.
const { frames: FRAMES, macLabels: LABELS, errorCodes: ERROR_CODES } = PROTOCOL;
const PROXY_CODES = new Set(Object.values(ERROR_CODES));
const DEFAULT_LOOPBACK_DIAL_HOST = 'host.docker.internal';
// Test seam (documented as tests-only): the name dialled for a proxy that listens on the host's loopback.
const DIAL_HOST_ENV = 'CODE_BROWSER_PROXY_DIAL_HOST';
const NONCE_RE = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((PROTOCOL.nonceBytes * 8) / 6)}}$`);
const MAC_RE = /^[0-9a-f]{64}$/;

export const proxyError = (message, code) => Object.assign(new Error(message), { code });
const badFrame = (message) => proxyError(message, ERROR_CODES.badFrame);

// Whether the backend runs inside a container: Docker's `/.dockerenv` or Podman's `/run/.containerenv`.
export const runningInContainer = () => existsSync('/.dockerenv') || existsSync('/run/.containerenv');

// The default gateway in `/proc/net/route` text: the gateway of the first default route, or null. Fields are
// hex in host byte order, so this reads them as a little-endian host does.
export function parseDefaultGateway(text) {
  for (const line of text.split('\n').slice(1)) {
    const [, dest, gateway, flags] = line.trim().split(/\s+/);
    if (dest !== '00000000' || !/^[0-9A-Fa-f]{8}$/.test(gateway ?? '') || !(parseInt(flags, 16) & 0x2)) continue;
    const n = parseInt(gateway, 16);
    return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24].join('.');
  }
  return null;
}

// From inside a bridge container, the default gateway is the Docker host.
export function defaultGatewayIPv4() {
  try { return parseDefaultGateway(readFileSync('/proc/net/route', 'utf8')); } catch { return null; }
}

// Where to dial a proxy that listens on `listenHost`. Outside a container, as written. Inside one, a loopback
// listener is reached through the Docker Desktop host name; any other address as written, then the default gateway.
export function dialCandidates(listenHost, { inContainer, gateway, loopbackHost = DEFAULT_LOOPBACK_DIAL_HOST }) {
  if (!inContainer) return [listenHost];
  if (net.isIPv4(listenHost) && listenHost.startsWith('127.')) return [loopbackHost];
  return [...new Set([listenHost, gateway].filter(Boolean))];
}

export function mac(secret, label, nonceProxy, nonceClient, port) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update([label, nonceProxy, nonceClient, String(port)].join('\n'), 'utf8').digest('hex');
}

// Constant-time comparison of a MAC against the expected one.
export function verifyMac(expected, given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const isObj = (f) => f !== null && typeof f === 'object' && !Array.isArray(f);
function checkShape(obj, shape, what) {
  const keys = Object.keys(obj);
  if (keys.length !== Object.keys(shape).length || !keys.every((k) => Object.hasOwn(shape, k))) {
    throw badFrame(`${what} must have exactly the keys ${Object.keys(shape).sort().join(', ')}`);
  }
  for (const [k, ok] of Object.entries(shape)) if (!ok(obj[k])) throw badFrame(`${what}: ${k} is malformed`);
}
const isStr = (v) => typeof v === 'string';
const HELLO_SHAPE = { t: isStr, v: Number.isInteger, nonce: isStr };
const WELCOME_SHAPE = { t: isStr, mac: isStr };
const ERROR_SHAPE = { t: isStr, code: isStr, message: isStr };

// Frames off `socket`, one at a time. Lines are cut only when asked for, so the bytes after the last frame
// read stay untouched: `detach()` stops reading and hands them back (the target's first bytes).
export function lineReader(socket, maxBytes) {
  let buf = Buffer.alloc(0);
  let ended = false;
  let failure = null;
  let waiter = null;
  const wake = () => { const w = waiter; waiter = null; w?.(); };
  const onData = (chunk) => { buf = buf.length ? Buffer.concat([buf, chunk]) : chunk; wake(); };
  const onEnd = () => { ended = true; wake(); };
  const onError = (e) => { failure = e; wake(); };
  socket.on('data', onData);
  socket.on('end', onEnd);
  socket.on('close', onEnd);
  socket.on('error', onError);
  const take = () => {
    const i = buf.indexOf(10);
    if ((i === -1 ? buf.length : i + 1) > maxBytes) throw badFrame(`a frame from the proxy is longer than ${maxBytes} bytes`);
    if (i === -1) return undefined;
    const line = buf.subarray(0, i).toString('utf8');
    buf = buf.subarray(i + 1);
    let f;
    try { f = JSON.parse(line); } catch { throw badFrame('a frame from the proxy is not JSON'); }
    if (!isObj(f) || typeof f.t !== 'string') throw badFrame('a frame from the proxy is not an object with a string t');
    return f;
  };
  return {
    async next() {
      for (;;) {
        const f = take();
        if (f !== undefined) return f;
        if (failure) throw failure;
        if (ended) return null;
        await new Promise((r) => { waiter = r; });
      }
    },
    detach() {
      socket.pause();
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      socket.off('error', onError);
      const rest = buf;
      buf = Buffer.alloc(0);
      return rest;
    },
  };
}

// Authenticate one connection for `port`. Resolves with the bytes that followed the welcome once the proxy has
// proven the secret. Rejects with `code`: the proxy's error code, 'impostor', 'closed' or the bad-frame code.
export async function handshake(socket, reader, { secret, port, where }) {
  const hello = await reader.next();
  if (hello === null) throw proxyError(`the proxy at ${where} closed the connection before its hello`, 'closed');
  if (hello.t !== FRAMES.hello) throw badFrame(`the proxy at ${where} sent ${JSON.stringify(hello.t)} instead of its hello`);
  if (Number.isInteger(hello.v) && hello.v !== PROTOCOL.protocolVersion) {
    throw proxyError(`the proxy at ${where} speaks protocol ${hello.v}, this code-browser speaks ${PROTOCOL.protocolVersion} — update the proxy/ copy on the host`, ERROR_CODES.versionMismatch);
  }
  checkShape(hello, HELLO_SHAPE, 'the proxy hello');
  if (!NONCE_RE.test(hello.nonce)) throw badFrame('the proxy hello carries a malformed nonce');
  const nonceClient = crypto.randomBytes(PROTOCOL.nonceBytes).toString('base64url');
  socket.write(`${JSON.stringify({ t: FRAMES.auth, v: PROTOCOL.protocolVersion, nonce: nonceClient, port, mac: mac(secret, LABELS.client, hello.nonce, nonceClient, port) })}\n`);
  const reply = await reader.next();
  if (reply === null) throw proxyError(`the proxy at ${where} closed the connection during the handshake`, 'closed');
  if (reply.t === FRAMES.error) {
    checkShape(reply, ERROR_SHAPE, 'the proxy error');
    // An error frame precedes any proof of the secret: its text is the peer's claim, passed on as such.
    throw proxyError(`the proxy at ${where} refused the connection (unverified: this peer has not proved the secret): ${reply.message}`, reply.code);
  }
  if (reply.t !== FRAMES.welcome) throw badFrame(`the proxy at ${where} sent ${JSON.stringify(reply.t)} instead of its welcome`);
  checkShape(reply, WELCOME_SHAPE, 'the proxy welcome');
  // Nothing after the welcome is used, data bytes included, before this check.
  if (!MAC_RE.test(reply.mac) || !verifyMac(mac(secret, LABELS.proxy, hello.nonce, nonceClient, port), reply.mac)) {
    throw proxyError(`the proxy at ${where} could not prove the secret`, 'impostor');
  }
  return reader.detach();
}

// At most `max` jobs at once; the rest wait, first in first out. Every handshake runs inside one, which keeps
// the backend below the proxy's cap on unauthenticated connections. A job whose `signal` aborts while it waits
// leaves the queue and rejects with the abort's reason; once running, the job itself observes the signal.
export function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length) {
      const job = queue.shift();
      active += 1;
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { active -= 1; pump(); });
    }
  };
  return {
    get inFlight() { return active; },
    run(fn, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason); return; }
        const job = { fn, resolve, reject };
        const onAbort = () => {
          const i = queue.indexOf(job);
          if (i >= 0) { queue.splice(i, 1); reject(signal.reason); }
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        job.fn = () => { signal?.removeEventListener('abort', onAbort); return fn(); };
        queue.push(job);
        pump();
      });
    },
  };
}

const sharedLimiter = createLimiter(PROTOCOL.maxClientHandshakes);

// `allowHalfOpen`: the pipe carries a TCP stream whose half-close must not cut the reply.
function connect(host, port, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const socket = net.connect({ host, port, allowHalfOpen: true });
    const onAbort = () => { clearTimeout(timer); socket.destroy(); reject(signal.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(proxyError(`connecting to the proxy at ${host}:${port} timed out after ${timeoutMs} ms`, 'timeout'));
    }, timeoutMs);
    const onError = (e) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(proxyError(`cannot reach the proxy at ${host}:${port}: ${e.message}`, e.code)); };
    socket.once('error', onError);
    socket.once('connect', () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); socket.off('error', onError); resolve(socket); });
  });
}

function dialAndAuth({ host, port, target, secret, limiter, signal }) {
  const where = `${host}:${port}`;
  return limiter.run(async () => {
    const socket = await connect(host, port, PROTOCOL.connectTimeoutMs, signal);
    const onAbort = () => socket.destroy();
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.setNoDelay(true);
    const reader = lineReader(socket, PROTOCOL.maxFrameBytes);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(proxyError(`the proxy at ${where} did not complete the handshake within ${PROTOCOL.handshakeTimeoutMs} ms`, 'timeout')), PROTOCOL.handshakeTimeoutMs);
    });
    try {
      const head = await Promise.race([handshake(socket, reader, { secret, port: target, where }), timeout]);
      return { socket, head };
    } catch (e) {
      socket.destroy();
      throw signal?.aborted ? signal.reason : e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }, signal);
}

// One authenticated connection to 127.0.0.1:`port` on the Docker host, through the proxy that `<dataDir>/proxy/`
// names: `{socket, head}` (head: bytes the target already sent). Rejects with a message saying what to do, or with
// `signal`'s reason once it aborts.
export async function openProxied(dataDir, port, { env = process.env, inContainer = runningInContainer, gateway = defaultGatewayIPv4, limiter = sharedLimiter, signal } = {}) {
  const host = await readHost(dataDir);
  if (!host) throw proxyError('no CDP proxy is running: start it on the Docker host with `python3 proxy/cdp_proxy.py` from the code-browser checkout (docs/proxy.md)', 'no_proxy');
  if (host.error) throw proxyError(host.error, 'bad_host_file');
  const secret = await ensureSecret(dataDir);
  let last = null;
  for (const candidate of dialCandidates(host.listenHost, { inContainer: inContainer(), gateway: gateway(), loopbackHost: env[DIAL_HOST_ENV] || DEFAULT_LOOPBACK_DIAL_HOST })) {
    try {
      return await dialAndAuth({ host: candidate, port: host.listenPort, target: port, secret, limiter, signal });
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      if (PROXY_CODES.has(e.code)) throw e; // a proxy answered with an error code: another address won't answer differently
      last = e;
    }
  }
  throw last;
}
