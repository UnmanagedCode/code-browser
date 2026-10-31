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

export function liveStack({ env = {}, leaseMs = 30_000 } = {}) {
  const dataDir = tmpDir();
  const manager = createBrowserManager({
    dataDir,
    env: { ...process.env, CODE_BROWSER_CHROMIUM: FAKE_CHROMIUM, ...env },
    log: { warn() {}, error() {} },
    timeouts: { launch: 4000, stopGrace: 1500, killGrace: 200, shutdownGrace: 500 },
    createSession: (entry) => createBrowserSession({
      name: entry.name, cdp: entry.cdp, sandbox: entry.sandbox, log: { warn() {} }, controllerOptions: { leaseMs },
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
