// An in-process stand-in for proxy/proxy.py, so the default `npm test` covers the proxied path without Python.
// It speaks the real wire protocol (proxy/protocol.json) with its own HMAC code, refuses the auth frames the real
// proxy refuses (same checks, same order, same codes), publishes host.json in <dataDir>/proxy/, and pipes an
// authenticated connection to 127.0.0.1:<port>. `mode: 'blackhole'` accepts and never says hello.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PROTOCOL } from '../../src/proxyProtocol.js';

const { frames: F, macLabels: L, rendezvous: R, errorCodes: E } = PROTOCOL;
const NONCE_RE = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((PROTOCOL.nonceBytes * 8) / 6)}}$`);
const MAC_RE = /^[0-9a-f]{64}$/;
const AUTH_KEYS = ['mac', 'nonce', 'port', 't', 'v'];

// Python's json reads a number written with a fraction or exponent as a float: keep that distinction ({float}).
const pyJson = (text) => JSON.parse(text, (_k, v, ctx) => (typeof v === 'number' && !/^-?\d+$/.test(ctx.source) ? { float: v } : v));
// Python's `!=` treats True as 1 and 1.0 as 1.
const pyNumber = (x) => (x === true ? 1 : x === false ? 0 : x?.float ?? x);

// The error code the real proxy answers a parsed-or-not auth line with before reading the secret, or null.
function authProblem(text) {
  let f;
  try { f = pyJson(text); } catch { return E.badFrame; }
  if (!f || typeof f !== 'object' || Array.isArray(f) || f.t !== F.auth) return E.badFrame;
  if (pyNumber(f.v) !== PROTOCOL.protocolVersion) return E.versionMismatch; // then `v: true` / `1.0` fail the shape
  const shapeOk = Object.keys(f).sort().join() === AUTH_KEYS.join() && Number.isInteger(f.v) && typeof f.nonce === 'string'
    && typeof f.mac === 'string' && Number.isInteger(f.port) && NONCE_RE.test(f.nonce) && MAC_RE.test(f.mac)
    && f.port >= PROTOCOL.port.min && f.port <= PROTOCOL.port.max;
  return shapeOk ? null : E.badFrame;
}
const hmac = (secret, label, np, nc, port) => crypto.createHmac('sha256', secret).update([label, np, nc, String(port)].join('\n')).digest('hex');
const line = (obj) => `${JSON.stringify(obj)}\n`;

export async function fakeProxy(dataDir, { mode = 'pipe' } = {}) {
  const dir = path.join(dataDir, R.dir);
  const sockets = new Set();
  const track = (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); };
  const server = net.createServer((client) => {
    track(client);
    if (mode === 'blackhole') { client.resume(); return; }
    const nonce = crypto.randomBytes(PROTOCOL.nonceBytes).toString('base64url');
    client.write(line({ t: F.hello, v: PROTOCOL.protocolVersion, nonce }));
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf(10);
      if (i < 0) return;
      client.off('data', onData);
      client.pause();
      const text = buf.subarray(0, i).toString();
      const rest = buf.subarray(i + 1);
      const refuse = (code, message) => client.end(line({ t: F.error, code, message }));
      const problem = authProblem(text);
      if (problem) { refuse(problem, 'refused by the fake proxy'); return; }
      const auth = JSON.parse(text);
      let secret;
      try { secret = JSON.parse(fs.readFileSync(path.join(dir, R.backendFile), 'utf8')).secret; } catch { secret = null; }
      if (typeof secret !== 'string' || secret.length < PROTOCOL.minSecretLength) { refuse(E.noSecret, 'no usable secret'); return; }
      if (auth.mac !== hmac(secret, L.client, nonce, auth.nonce, auth.port)) { refuse(E.authFailed, 'authentication failed'); return; }
      let connected = false;
      const up = net.connect(auth.port, '127.0.0.1', () => {
        connected = true;
        client.write(line({ t: F.welcome, mac: hmac(secret, L.proxy, nonce, auth.nonce, auth.port) }));
        if (rest.length) up.write(rest);
        client.pipe(up);
        up.pipe(client);
        client.resume();
      });
      track(up);
      up.on('error', () => { if (!connected) refuse(E.connectFailed, `nothing listens on 127.0.0.1:${auth.port}`); });
      up.on('close', () => { if (connected) client.destroy(); });
      client.on('close', () => up.destroy());
    };
    client.on('data', onData);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, R.proxyFile), JSON.stringify({ protocolVersion: PROTOCOL.protocolVersion, listen: `127.0.0.1:${port}`, pid: process.pid }));
  return {
    port,
    connections: () => sockets.size,
    close: () => { server.close(); for (const s of sockets) s.destroy(); },
  };
}
