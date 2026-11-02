import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { createBrowserManager } from '../src/browserManager.js';
import { createBrowserSession } from '../src/browserSession.js';
import { CdpConnection } from '../src/cdp.js';
import { createViewerGateway } from '../src/viewerGateway.js';

export function tmpDir(prefix = 'code-browser-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// code-browser's data dir under a projects root, as cc sets CONDUCTOR_PLUGIN_DATA_DIR and as the proxy finds it
// (STORE_RELPATH in proxy/cdp_proxy.py).
export const storeDir = (projectsRoot) => path.join(projectsRoot, '.code-conductor', 'plugins', 'data', 'code-browser');

export function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Raw request with full control of Host/Origin/Content-Type (fetch forbids some of them).
export function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export const JSON_HEADERS = { 'content-type': 'application/json' };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll until `fn` returns truthy. Short steps and a hard cap keep failures fast.
export async function waitFor(fn, { timeout = 3000, step = 25, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(step);
  }
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// Fake clock: `schedule` returns a cancel function; `advance` runs due timers in order.
export function fakeClock() {
  let t = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => t,
    schedule(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return () => timers.delete(id);
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

// Inverse of src/frame.js encodeFrame.
export function decodeFrame(buf) {
  const headLen = buf.readUInt32BE(0);
  return { header: JSON.parse(buf.subarray(4, 4 + headLen).toString('utf8')), jpeg: buf.subarray(4 + headLen) };
}

// ---- live-stack helpers: real manager + session + gateway over the fake Chromium ----

export const FAKE_CHROMIUM = new URL('./fakes/fakeChromium.mjs', import.meta.url).pathname;

export function liveStack({ env = {}, leaseMs = 30_000, clock = null, dataDir = tmpDir() } = {}) {
  const manager = createBrowserManager({
    dataDir,
    env: { ...process.env, CODE_BROWSER_CHROMIUM: FAKE_CHROMIUM, CODE_BROWSER_PROXY_DIAL_HOST: '127.0.0.1', ...env },
    log: { warn() {}, error() {} },
    timeouts: { launch: 4000, stopGrace: 1500, killGrace: 200, shutdownGrace: 500 },
    createSession: (entry) => createBrowserSession({
      name: entry.name, cdp: entry.cdp, sandbox: entry.sandbox, attached: entry.kind === 'attached', log: { warn() {} },
      controllerOptions: { leaseMs, ...(clock ? { schedule: clock.schedule } : {}) },
    }),
  });
  const gateway = createViewerGateway({ manager, log: { error() {} }, pingMs: 60_000 });
  const server = createApp({ manager, mcp: { handle: async () => ({}) }, distDir: path.join(dataDir, 'dist'), onUpgrade: gateway.handleUpgrade });
  const sockets = [];
  const cdps = [];
  const stack = {
    manager, gateway, server, dataDir,
    async start(name = 'a') {
      manager.ensure(name);
      await manager.start(name);
      return manager.session(name);
    },
    // A second, independent CDP client, like an agent's Playwright, with the fake's test-only methods.
    async agent(name = 'a') {
      const [port, wsPath] = fs.readFileSync(path.join(dataDir, 'profiles', name, 'DevToolsActivePort'), 'utf8').trim().split('\n');
      const conn = await CdpConnection.connect(`ws://127.0.0.1:${port}${wsPath}`);
      cdps.push(conn);
      return conn;
    },
    async listen() { stack.port = await listen(server); return stack.port; },
    async viewer({ viewerId = `viewer-${sockets.length}-abcdefgh`, origin, hello = true } = {}) {
      const ws = new WebSocket(`ws://127.0.0.1:${stack.port}/api/ws`, { headers: { origin: origin ?? `http://127.0.0.1:${stack.port}` } });
      const v = { ws, viewerId, messages: [], frames: [] };
      ws.on('message', (d, isBinary) => {
        if (isBinary) v.frames.push(decodeFrame(d)); else v.messages.push(JSON.parse(d.toString()));
      });
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      v.send = (msg) => ws.send(JSON.stringify(msg));
      v.of = (type) => v.messages.filter((m) => m.type === type);
      v.last = (type) => v.of(type).at(-1);
      v.waitFor = (fn, what) => waitFor(() => fn(v), { what });
      sockets.push(ws);
      if (hello) v.send({ msg: 'hello', viewerId });
      return v;
    },
    async recorded(name = 'a') {
      const a = await stack.agent(name);
      return (await a.send('Fake.getRecorded')).recorded;
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      for (const c of cdps) c.close();
      gateway.close();
      server.close();
      await manager.shutdown();
    },
  };
  return stack;
}

// Send raw bytes over TCP and return everything the server answers until it closes the connection.
export function rawExchange(port, text, { timeout = 2000 } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    let buf = '';
    s.on('data', (d) => { buf += d; });
    s.on('close', () => resolve(buf));
    s.on('error', () => resolve(buf));
    setTimeout(() => { s.destroy(); }, timeout).unref();
  });
}

// ---- attached browsers: a fake Chromium the "user" launched themselves, and the CDP proxy ----

const liveChildren = new Set();
process.once('exit', () => { for (const c of liveChildren) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
const track = (child) => { liveChildren.add(child); child.once('exit', () => liveChildren.delete(child)); return child; };

// A fake Chromium started outside code-browser, as a user starts their own browser. `approval` runs it in Chrome's
// own-profile approval mode; `answer('allow'|'deny')` answers its held connection, `pending()` counts them.
export async function externalFake({ approval = false, env = {} } = {}) {
  const profile = tmpDir('code-browser-external-');
  const child = track(spawn(process.execPath, [FAKE_CHROMIUM, `--user-data-dir=${profile}`], {
    stdio: 'ignore', env: { ...process.env, ...(approval ? { FAKE_CHROMIUM_APPROVAL: '1' } : {}), ...env },
  }));
  const [port, wsPath] = await waitFor(() => {
    try { const l = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n'); return l.length === 2 && l; } catch { return null; }
  }, { what: 'the external fake to listen', timeout: 5000 });
  const fake = {
    port: Number(port), wsPath, profile, pid: child.pid, address: `127.0.0.1:${port}`,
    alive: () => child.exitCode === null && child.signalCode === null,
    kill: () => { child.kill('SIGKILL'); return new Promise((r) => (fake.alive() ? child.once('exit', r) : r())); },
    approval: (method = 'GET', answer = '') => request(fake.port, { method, path: `/fake/approval${answer && `?answer=${answer}`}` }).then((r) => r.json),
    pending: async () => (await fake.approval()).pending,
    answer: (answer) => fake.approval('PUT', answer),
    // A CDP client straight to the browser, with the fake's test-only methods (not in approval mode).
    agent: () => CdpConnection.connect(`ws://127.0.0.1:${port}${wsPath}`),
  };
  return fake;
}

let pythonCache = null;
// The interpreter for the proxy: CODE_BROWSER_PYTHON (e.g. python3.9), else python3; {ok, cmd, args} or {ok:false, reason}.
export function findPython() {
  if (pythonCache) return pythonCache;
  const spec = process.env.CODE_BROWSER_PYTHON || 'python3';
  const [cmd, ...args] = spec.split(/\s+/).filter(Boolean);
  try {
    const out = execFileSync(cmd, [...args, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const [major, minor] = out.split('.').map(Number);
    pythonCache = major > 3 || (major === 3 && minor >= 9) ? { ok: true, cmd, args, version: out } : { ok: false, reason: `${spec} is Python ${out}` };
  } catch (e) {
    pythonCache = { ok: false, reason: `${spec} could not run (${e.code ?? e.message})` };
  }
  return pythonCache;
}

const PYTHON_MISSING = 'python3 >= 3.9 not found: install it, point CODE_BROWSER_PYTHON at it, or set CODE_BROWSER_SKIP_PYTHON=1 to skip';

// Gate for a Python-dependent test, called first in its body. Fails closed: with no usable interpreter the test
// FAILS, unless CODE_BROWSER_SKIP_PYTHON=1 opts out explicitly, which skips it. True when the test may proceed.
export function requirePython(t) {
  const py = findPython();
  if (py.ok) return true;
  if (process.env.CODE_BROWSER_SKIP_PYTHON === '1') { t.skip(`${PYTHON_MISSING} (${py.reason})`); return false; }
  throw new Error(`${PYTHON_MISSING} (${py.reason})`);
}

export const PROXY_SCRIPT = new URL('../proxy/cdp_proxy.py', import.meta.url).pathname;

// The real proxy on 127.0.0.1:<any>, for the store under `projectsRoot`, forwarding to `ports` (its default when null).
export async function startProxy({ projectsRoot, ports = null }) {
  const py = findPython();
  if (!py.ok) throw new Error(`${PYTHON_MISSING} (${py.reason})`);
  fs.mkdirSync(storeDir(projectsRoot), { recursive: true });
  const argv = [...py.args, PROXY_SCRIPT, '--projects-root', projectsRoot, '--listen', '127.0.0.1:0', ...(ports ? ['--ports', ports.join(',')] : [])];
  const proc = track(spawn(py.cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }));
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const m = await waitFor(() => /listening on 127\.0\.0\.1:(\d+)/.exec(out) || proc.exitCode !== null || proc.signalCode !== null, { what: 'the proxy to listen', timeout: 10_000 });
  if (m === true) throw new Error(`the proxy exited: ${out}`);
  const exited = () => proc.exitCode !== null || proc.signalCode !== null;
  const end = (signal) => new Promise((r) => { if (exited()) r(); else { proc.once('exit', r); proc.kill(signal); } });
  return { proc, port: Number(m[1]), log: () => out, stop: () => end('SIGTERM'), kill: () => end('SIGKILL') };
}

// Resolves with the exit code once `proc` has closed (stdio drained, so its captured output is complete). After `ms` it
// SIGKILLs `proc` and rejects: a subject that should have exited but did not fails the test instead of hanging it.
export function waitForExit(proc, ms, what = 'the process') {
  return new Promise((resolve, reject) => {
    const drained = () => [proc.stdout, proc.stderr].every((st) => !st || st.destroyed);
    if ((proc.exitCode !== null || proc.signalCode !== null) && drained()) { resolve(proc.exitCode); return; }
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`${what} did not exit within ${ms} ms`)); }, ms);
    proc.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });
}

// `promise`, or a rejection naming `what` after `ms`: a test whose subject hangs fails instead of hanging.
export function within(promise, ms, what) {
  let timer;
  const bound = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms); });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

// An HTTP server whose answer to any request starts and then stops: `truncate` sends headers promising a body, one
// byte of it, then destroys the socket; `stall` sends the same and then sends nothing more.
export async function brokenAnswer(mode) {
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
    s.once('data', () => {
      s.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{');
      if (mode === 'truncate') setTimeout(() => s.destroy(), 20);
    });
  });
  const port = await listen(server);
  return { port, address: `127.0.0.1:${port}`, open: () => sockets.size, close: () => { server.close(); for (const s of sockets) s.destroy(); } };
}
