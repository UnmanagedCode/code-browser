import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../src/app.js';
import { parseAttachTarget } from '../src/attachStore.js';
import { CodedError } from '../src/errors.js';
import { CSP, readBytesBody } from '../src/http.js';
import { ARTIFACT_MAX_BYTES } from '../src/limits.js';
import { buildRoutes } from '../src/routes.js';
import { JSON_HEADERS, listen, rawExchange, request, tmpDir } from './helpers.mjs';

const MUTATORS = ['create', 'start', 'stop', 'delete', 'setAllowUnsandboxed', 'attach', 'connect'];

// A manager double that records every call; `hang` makes every method never resolve.
function fakeManager({ hang = false } = {}) {
  const calls = [];
  const browsers = new Map();
  const rec = (m, fn) => (...a) => {
    calls.push(m);
    if (hang) return new Promise(() => {});
    return fn(...a);
  };
  return {
    calls,
    list: rec('list', () => [...browsers.values()]),
    summary: rec('summary', (n) => browsers.get(n)),
    create: rec('create', (n) => {
      if (browsers.has(n)) throw new CodedError('EXISTS', 'exists');
      if (!/^[a-z0-9-]+$/.test(String(n))) throw new CodedError('INVALID_NAME', 'bad name');
      browsers.set(n, { name: n, status: 'stopped' });
      return { name: n };
    }),
    start: rec('start', (n) => { browsers.get(n).status = 'running'; }),
    stop: rec('stop', (n) => { browsers.get(n).status = 'stopped'; }),
    setAllowUnsandboxed: rec('setAllowUnsandboxed', (n, allow) => {
      if (!browsers.has(n)) throw new CodedError('NOT_FOUND', 'no such browser');
      browsers.get(n).allowUnsandboxed = allow;
    }),
    delete: rec('delete', (n) => {
      if (!browsers.delete(n)) throw new CodedError('NOT_FOUND', 'no such browser');
    }),
    // Like the real manager: validates synchronously, then returns the connect's promise (which may fail later).
    attach: rec('attach', (n, body) => {
      const target = parseAttachTarget(body);
      browsers.set(n, { name: n, kind: 'attached', status: 'connecting', attached: { address: target.address, via: target.via } });
      return Promise.reject(new CodedError('ATTACH_FAILED', 'nobody allowed it'));
    }),
    connect: rec('connect', (n) => {
      if (browsers.get(n)?.kind !== 'attached') throw new CodedError('BAD_REQUEST', 'not attached');
      browsers.get(n).status = 'connecting';
      return new Promise(() => {});
    }),
  };
}

// An installer double that records every call; `hang` makes start and state throw (health must never reach them).
function fakeInstaller({ hang = false } = {}) {
  const calls = [];
  let status = 'idle';
  const view = () => ({ status, error: null, exitCode: null, logTail: '' });
  return {
    calls,
    state() { calls.push('state'); if (hang) throw new Error('hung'); return view(); },
    start() {
      calls.push('start');
      if (hang) throw new Error('hung');
      if (status === 'running') throw new CodedError('INSTALL_RUNNING', 'a Chromium install is already running');
      status = 'running';
      return view();
    },
    close() {},
  };
}

const servers = [];
async function boot({ manager = fakeManager(), dist, mcp, installer = fakeInstaller(), dataDir, token } = {}) {
  const mcpStub = mcp ?? { calls: [], async handle(body) { this.calls.push(body); return { result: 'ok' }; } };
  const server = createApp({ manager, mcp: mcpStub, installer, distDir: dist ?? path.join(tmpDir(), 'missing'), dataDir, token });
  const port = await listen(server);
  servers.push(server);
  return { port, manager, mcp: mcpStub, installer, host: `127.0.0.1:${port}` };
}
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

function builtDist() {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, 'assets'));
  fs.writeFileSync(path.join(d, 'index.html'), '<!doctype html><title>x</title>');
  fs.writeFileSync(path.join(d, 'assets', 'app.js'), 'export {}');
  fs.writeFileSync(path.join(d, 'secret.txt'), 'nope');
  fs.writeFileSync(path.join(d, 'assets', 'notes.txt'), 'nope');
  return d;
}

// Invariant: health answers without touching the manager, so a hung browser never fails cc's health probe.
test('health answers while every manager method hangs', async () => {
  const { port, manager, installer } = await boot({ manager: fakeManager({ hang: true }), installer: fakeInstaller({ hang: true }) });
  const r = await request(port, { path: '/api/health' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.deepEqual(manager.calls, []);
  assert.deepEqual(installer.calls, []);
});

// Invariant: every response the backend produces carries the CSP and nosniff, including errors.
test('CSP and nosniff on 200, 404, 503 and clientError', async () => {
  const { port } = await boot();
  const responses = [
    await request(port, { path: '/api/health' }),
    await request(port, { path: '/api/nope' }),
    await request(port, { path: '/' }),
  ];
  assert.deepEqual(responses.map((r) => r.status), [200, 404, 503]);
  for (const r of responses) {
    assert.equal(r.headers['content-security-policy'], CSP);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  }
  const raw = await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('GARBAGE\r\n\r\n'));
    let buf = '';
    s.on('data', (d) => { buf += d; });
    s.on('close', () => resolve(buf));
  });
  assert.match(raw, /^HTTP\/1\.1 400/);
  assert.match(raw, /Content-Security-Policy: default-src 'none'/i);
});

// Invariant: only the shell and allowlisted assets are served; the SPA never falls back; host URLs get a real 404.
test('static allowlist, unbuilt 503 and host-URL 404', async () => {
  const { port } = await boot({ dist: builtDist() });
  assert.equal((await request(port, { path: '/' })).status, 200);
  assert.equal((await request(port, { path: '/index.html' })).status, 200);
  const js = await request(port, { path: '/assets/app.js' });
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);
  for (const p of ['/secret.txt', '/assets/notes.txt', '/assets/../secret.txt', '/assets/%2e%2e/secret.txt', '/some/route', '/pluginBridge.js', '/pluginTheme.css']) {
    assert.equal((await request(port, { path: p })).status, 404, p);
  }
  const unbuilt = await boot();
  const r = await request(unbuilt.port, { path: '/' });
  assert.equal(r.status, 503);
  assert.match(r.text, /UI not built/);
});

// Invariant: the REST surface creates, lists, starts, stops and deletes browsers through the manager.
test('REST CRUD', async () => {
  const { port, host } = await boot();
  const same = { ...JSON_HEADERS, host, origin: `http://${host}` };
  const created = await request(port, { method: 'POST', path: '/api/browsers', headers: same, body: '{"name":"a"}' });
  assert.equal(created.status, 201);
  assert.equal(created.json.browser.status, 'running');
  assert.equal((await request(port, { method: 'POST', path: '/api/browsers', headers: same, body: '{"name":"a"}' })).status, 409);
  assert.equal((await request(port, { method: 'POST', path: '/api/browsers', headers: same, body: '{"name":"Bad Name"}' })).status, 400);
  assert.equal((await request(port, { path: '/api/browsers' })).json.browsers.length, 1);
  const stopped = await request(port, { method: 'POST', path: '/api/browsers/a/stop', headers: same, body: '{}' });
  assert.equal(stopped.json.browser.status, 'stopped');
  const started = await request(port, { method: 'POST', path: '/api/browsers/a/start', headers: same, body: '{}' });
  assert.equal(started.json.browser.status, 'running');
  assert.equal((await request(port, { method: 'DELETE', path: '/api/browsers/a', headers: same })).status, 200);
  assert.equal((await request(port, { method: 'DELETE', path: '/api/browsers/a', headers: same })).status, 404);
});

const MUTATING = [
  { method: 'POST', path: '/api/mcp', body: '{"tool":"start_browser","arguments":{"name":"x"}}' },
  { method: 'POST', path: '/api/browsers', body: '{"name":"x"}' },
  { method: 'POST', path: '/api/browsers/x/start', body: '{}' },
  { method: 'POST', path: '/api/browsers/x/stop', body: '{}' },
  { method: 'POST', path: '/api/browsers/x/allow-unsandboxed', body: '{"allow":true}', panelOnly: true },
  { method: 'POST', path: '/api/browsers/x/attach', body: '{"address":"127.0.0.1:9222","via":"proxy"}', panelOnly: true },
  { method: 'POST', path: '/api/browsers/x/connect', body: '{}', panelOnly: true },
  { method: 'POST', path: '/api/chromium/install', body: '{}', panelOnly: true },
  { method: 'DELETE', path: '/api/browsers/x', body: undefined },
];

// Invariant: a state-changing request without a JSON content type (the only kind a no-cors page can send)
// is refused with 415 before any handler runs, with or without a foreign Origin.
test('non-JSON content types are refused with 415 and run nothing', async () => {
  const { port, manager, mcp, installer } = await boot();
  for (const route of MUTATING) {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', undefined]) {
      for (const origin of [undefined, 'http://evil.test']) {
        const headers = {};
        if (type) headers['content-type'] = type;
        if (origin) headers.origin = origin;
        const r = await request(port, { method: route.method, path: route.path, body: route.body, headers });
        // A foreign Origin is refused first (403), and so is a panel-only route with no Origin; otherwise the content type is (415).
        assert.equal(r.status, origin || route.panelOnly ? 403 : 415, `${route.method} ${route.path} ${type} ${origin}`);
      }
    }
  }
  assert.deepEqual(manager.calls, []);
  assert.deepEqual(mcp.calls, []);
  assert.deepEqual(installer.calls, []);
});

// Invariant: a foreign Origin is refused with 403 even when the body is valid JSON, api/mcp included.
test('a foreign or mismatched Origin is refused with 403 even with JSON', async () => {
  const { port, manager, mcp, installer } = await boot();
  for (const route of MUTATING) {
    for (const origin of ['http://evil.test', 'http://127.0.0.1:1']) {
      const r = await request(port, { method: route.method, path: route.path, body: route.body, headers: { ...JSON_HEADERS, origin } });
      assert.equal(r.status, 403, `${route.method} ${route.path} ${origin}`);
    }
  }
  assert.deepEqual(manager.calls, []);
  assert.deepEqual(mcp.calls, []);
  assert.deepEqual(installer.calls, []);
});

// Invariant: starting a Chromium install is the panel's alone (no Origin → 403, nothing runs); a same-origin request
// starts one (202), a second is a 409 INSTALL_RUNNING, and the GET only reads.
test('chromium install: panel-only start, one at a time, read-only GET', async () => {
  const { port, host, installer } = await boot();
  const path = '/api/chromium/install';
  const same = { ...JSON_HEADERS, host, origin: `http://${host}` };
  const noOrigin = await request(port, { method: 'POST', path, headers: JSON_HEADERS, body: '{}' });
  assert.equal(noOrigin.status, 403);
  assert.match(noOrigin.json.error, /^FORBIDDEN: .*Origin/);
  assert.deepEqual(installer.calls, []);

  const idle = await request(port, { path });
  assert.equal(idle.status, 200);
  assert.equal(idle.json.install.status, 'idle');
  assert.deepEqual(installer.calls, ['state'], 'GET reads state and starts nothing');

  const first = await request(port, { method: 'POST', path, headers: same, body: '{}' });
  assert.equal(first.status, 202);
  assert.equal(first.json.install.status, 'running');
  const second = await request(port, { method: 'POST', path, headers: same, body: '{}' });
  assert.equal(second.status, 409);
  assert.match(second.json.error, /^INSTALL_RUNNING: /);
});

// Invariant: the opt-in route is the panel's alone: it needs the page's own Origin (a bridge or script that sends
// none gets 403 before any handler runs), JSON, and a boolean; a good request returns the summary.
test('allow-unsandboxed needs the same Origin, JSON and a boolean', async () => {
  const { port, host, manager } = await boot();
  await request(port, { method: 'POST', path: '/api/browsers', headers: { ...JSON_HEADERS, host, origin: `http://${host}` }, body: '{"name":"a"}' });
  manager.calls.length = 0;
  const path = '/api/browsers/a/allow-unsandboxed';
  const same = { ...JSON_HEADERS, host, origin: `http://${host}` };

  const noOrigin = await request(port, { method: 'POST', path, headers: JSON_HEADERS, body: '{"allow":true}' });
  assert.equal(noOrigin.status, 403);
  assert.match(noOrigin.json.error, /^FORBIDDEN: .*Origin/);
  assert.equal((await request(port, { method: 'POST', path, headers: { ...JSON_HEADERS, origin: 'http://evil.test' }, body: '{"allow":true}' })).status, 403);
  assert.equal((await request(port, { method: 'POST', path, headers: { ...same, 'content-type': 'text/plain' }, body: '{"allow":true}' })).status, 415);
  for (const bad of ['{"allow":"yes"}', '{}', '{"allow":1}']) {
    assert.equal((await request(port, { method: 'POST', path, headers: same, body: bad })).status, 400, bad);
  }
  assert.deepEqual(manager.calls, [], 'nothing reached the manager');

  const ok = await request(port, { method: 'POST', path, headers: same, body: '{"allow":true}' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.browser.allowUnsandboxed, true);
  const off = await request(port, { method: 'POST', path, headers: same, body: '{"allow":false}' });
  assert.equal(off.json.browser.allowUnsandboxed, false);
  assert.equal((await request(port, { method: 'POST', path: '/api/browsers/ghost/allow-unsandboxed', headers: same, body: '{"allow":true}' })).status, 404);
});

// Invariant: a start refused for want of a sandbox is a 409 carrying its code, so the panel can tell it from a failure.
test('start refused with SANDBOX_UNAVAILABLE answers 409 with that code', async () => {
  const manager = fakeManager();
  manager.start = async () => { throw new CodedError('SANDBOX_UNAVAILABLE', 'no sandbox'); };
  const { port, host } = await boot({ manager });
  const r = await request(port, { method: 'POST', path: '/api/browsers/x/start', headers: { ...JSON_HEADERS, host, origin: `http://${host}` }, body: '{}' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /^SANDBOX_UNAVAILABLE: /);
});

// Invariant: REST error bodies are additive: a CodedError's details come as `details`, and `error` still renders the
// extras (tried paths, install command, log tail) as text; an error without details has no `details` key.
test('REST errors add details and keep the rendered text', async () => {
  const manager = fakeManager();
  const post = async (path, host, port) => request(port, { method: 'POST', path, headers: { ...JSON_HEADERS, host, origin: `http://${host}` }, body: '{}' });
  const details = { tried: ['/p/chromium', '/q/chrome'], install: 'npm run install-browser' };
  manager.create = () => { throw new CodedError('CHROMIUM_NOT_FOUND', 'No Chromium found', details); };
  manager.start = async () => { throw new CodedError('LAUNCH_FAILED', 'Chromium exited during launch', { logTail: 'line1\nline2' }); };
  const { port, host } = await boot({ manager });
  const create = await request(port, { method: 'POST', path: '/api/browsers', headers: { ...JSON_HEADERS, host, origin: `http://${host}` }, body: '{"name":"x"}' });
  assert.equal(create.status, 500);
  assert.match(create.json.error, /^CHROMIUM_NOT_FOUND: /);
  for (const s of ['/p/chromium', '/q/chrome', 'npm run install-browser']) assert.ok(create.json.error.includes(s), s);
  assert.deepEqual(create.json.details, details);
  const start = await post('/api/browsers/x/start', host, port);
  assert.match(start.json.error, /^LAUNCH_FAILED: /);
  assert.ok(start.json.error.includes('line1\nline2'));
  assert.deepEqual(start.json.details, { logTail: 'line1\nline2' });
  manager.start = async () => { throw new CodedError('SANDBOX_UNAVAILABLE', 'no sandbox'); };
  const plain = await post('/api/browsers/x/start', host, port);
  assert.equal(plain.status, 409);
  assert.equal(Object.hasOwn(plain.json, 'details'), false);
});

// Invariant: cc's server-side MCP call (no Origin, JSON) is accepted on api/mcp.
test('api/mcp accepts no Origin with JSON', async () => {
  const { port, mcp } = await boot();
  const r = await request(port, { method: 'POST', path: '/api/mcp', headers: JSON_HEADERS, body: '{"tool":"list_browsers","arguments":{}}' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { result: 'ok' });
  assert.equal(mcp.calls.length, 1);
});

// Invariant: oversized and malformed bodies fail with 413 and 400, not a crash.
test('body limits and malformed JSON', async () => {
  const { port } = await boot();
  const big = await request(port, { method: 'POST', path: '/api/mcp', headers: JSON_HEADERS, body: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }) }).catch((e) => ({ status: e.code }));
  assert.ok(big.status === 413 || big.status === 'ECONNRESET', String(big.status));
  assert.equal((await request(port, { method: 'POST', path: '/api/mcp', headers: JSON_HEADERS, body: '{nope' })).status, 400);
});

// Invariant: GET routes never mutate; <img> tags and simple requests from any page can reach them.
test('every GET route leaves the mutating manager methods uncalled', async () => {
  const { port, manager, installer } = await boot();
  const gets = buildRoutes({ manager, mcp: {}, installer: fakeInstaller() }).filter((r) => r.method === 'GET');
  assert.ok(gets.length >= 2);
  for (const route of gets) {
    assert.equal(route.mutating, undefined, `${route.path} must not be marked mutating`);
  }
  for (const p of ['/api/health', '/api/browsers', '/api/browsers/x/start', '/api/browsers/x/stop', '/api/browsers/x', '/api/mcp', '/api/chromium/install']) {
    await request(port, { path: p, headers: { origin: 'http://evil.test' } });
    await request(port, { path: p });
  }
  for (const m of MUTATORS) assert.ok(!manager.calls.includes(m), `${m} was called by a GET`);
  assert.ok(!installer.calls.includes('start'), 'start was called by a GET');
});

// Invariant: a request target that is not a valid URL is a 400, not an unhandled throw (the guard still comes first).
test('malformed request targets answer 400', async () => {
  const { port, host } = await boot();
  for (const target of ['//[', 'http://[']) {
    const answer = await rawExchange(port, `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    assert.match(answer, /^HTTP\/1\.1 400 /, target);
    assert.match(answer, /content-security-policy/i);
  }
  const foreign = await rawExchange(port, `GET //[ HTTP/1.1\r\nHost: ${host}\r\nOrigin: http://evil.test\r\nConnection: close\r\n\r\n`);
  assert.match(foreign, /^HTTP\/1\.1 403 /, 'a foreign Origin is refused before the target is looked at');
  assert.equal((await request(port, { path: '/api/health' })).status, 200);
});

// Invariant: whatever the upgrade handler does, even throwing, the socket is destroyed and the process survives.
test('an upgrade handler that throws cannot take the process down', async () => {
  const server = createApp({ manager: fakeManager(), mcp: { handle: async () => ({}) }, distDir: tmpDir(), onUpgrade: () => { throw new Error('boom'); } });
  const port = await listen(server);
  servers.push(server);
  const answer = await rawExchange(port, `GET /api/ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
  assert.equal(answer, '');
  assert.equal((await request(port, { path: '/api/health' })).status, 200);
});

// Invariant: an upgrade under /api/relay/ goes to the relay only after the relay guard (no Origin, loopback Host on this
// port), and never to the panel's handler; every other upgrade still needs a matching Origin and never reaches the relay.
test('upgrade dispatch: relay guard for /api/relay/, Origin required elsewhere', async () => {
  const seen = [];
  const handler = (which) => (req, socket) => { seen.push(which); socket.end('HTTP/1.1 418 Teapot\r\nContent-Length: 0\r\n\r\n'); };
  const server = createApp({ manager: fakeManager(), mcp: { handle: async () => ({}) }, distDir: tmpDir(), onUpgrade: handler('panel'), onRelayUpgrade: handler('relay') });
  const port = await listen(server);
  servers.push(server);
  const upgrade = (p, headers) => rawExchange(port, `GET ${p} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
  const own = `127.0.0.1:${port}`;
  for (const headers of [
    { Host: own, Origin: `http://${own}` },
    { Host: `rebound.evil.test:${port}` },
    { Host: 'cc.example:9' },
    { Host: '127.0.0.1:9' },
  ]) {
    assert.match(await upgrade('/api/relay/a', headers), /^HTTP\/1\.1 403 /, JSON.stringify(headers));
  }
  assert.deepEqual(seen, []);
  assert.match(await upgrade('/api/relay/a', { Host: own }), /^HTTP\/1\.1 418 /);
  assert.match(await upgrade('/api/relay/a', { Host: `localhost:${port}` }), /^HTTP\/1\.1 418 /);
  assert.deepEqual(seen, ['relay', 'relay']);
  assert.match(await upgrade('/api/ws', { Host: own }), /^HTTP\/1\.1 403 /, 'the panel socket still needs an Origin');
  assert.match(await upgrade('/api/ws', { Host: own, Origin: `http://${own}` }), /^HTTP\/1\.1 418 /);
  assert.deepEqual(seen, ['relay', 'relay', 'panel']);
});

// Invariant: with no relay handler wired, a relay upgrade is a 404 and never reaches the panel's handler.
test('a relay upgrade without a relay is 404', async () => {
  let called = false;
  const server = createApp({ manager: fakeManager(), mcp: { handle: async () => ({}) }, distDir: tmpDir(), onUpgrade: () => { called = true; } });
  const port = await listen(server);
  servers.push(server);
  const answer = await rawExchange(port, `GET /api/relay/a HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
  assert.match(answer, /^HTTP\/1\.1 404 /);
  assert.equal(called, false);
});

// ---- artifacts: POST api/artifacts ----
const TOKEN = 'ab'.repeat(32);
const BYTES = { 'content-type': 'application/octet-stream' };

// Invariant: the artifacts route checks, in order, the Origin rule (403), the bearer token (401, whatever the content
// type), the content type (415) and the declared size (413); nothing is written before all pass.
test('artifacts: Origin, then token, then octet-stream, then size', async () => {
  const dataDir = tmpDir();
  const { port } = await boot({ dataDir, token: TOKEN });
  const auth = { authorization: `Bearer ${TOKEN}` };
  const post = (headers, body = 'x', p = '/api/artifacts?ext=png') => request(port, { method: 'POST', path: p, headers, body });
  assert.equal((await post({ ...BYTES, ...auth, origin: 'http://evil.test' })).status, 403);
  for (const headers of [BYTES, { 'content-type': 'text/plain' }, { ...BYTES, authorization: `Bearer ${'cd'.repeat(32)}` }, { ...BYTES, authorization: TOKEN }]) {
    const r = await post(headers);
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.match(r.json.error, /^UNAUTHORIZED: /);
  }
  for (const type of ['text/plain', 'application/json', 'multipart/form-data; boundary=x', undefined]) {
    assert.equal((await post({ ...auth, ...(type ? { 'content-type': type } : {}) })).status, 415, String(type));
  }
  const big = await rawExchange(port, `POST /api/artifacts?ext=png HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TOKEN}\r\n` +
    `Content-Type: application/octet-stream\r\nContent-Length: ${ARTIFACT_MAX_BYTES + 1}\r\nConnection: close\r\n\r\n`);
  assert.match(big, /^HTTP\/1\.1 413 /);
  assert.equal(fs.existsSync(path.join(dataDir, 'artifacts')), false, 'nothing written by a refused request');
  assert.equal((await post({ ...BYTES, ...auth }, 'x', '/api/artifacts?ext=..')).status, 400);
});

// Invariant: with no token configured, the artifacts route refuses everyone.
test('artifacts: no token configured means 401', async () => {
  const { port } = await boot({ dataDir: tmpDir() });
  const r = await request(port, { method: 'POST', path: '/api/artifacts?ext=png', headers: { ...BYTES, authorization: 'Bearer ' }, body: 'x' });
  assert.equal(r.status, 401);
});

// Invariant: an accepted artifact answers 201 with the path of a private file holding exactly the posted bytes.
test('artifacts: a valid post writes a private file and answers its path', async () => {
  const dataDir = tmpDir();
  const { port } = await boot({ dataDir, token: TOKEN });
  const bytes = Buffer.from([0, 1, 2, 255, 254]);
  const r = await request(port, { method: 'POST', path: '/api/artifacts?ext=png', headers: { ...BYTES, authorization: `Bearer ${TOKEN}` }, body: bytes });
  assert.equal(r.status, 201);
  assert.equal(path.dirname(r.json.path), path.join(dataDir, 'artifacts'));
  assert.deepEqual(fs.readFileSync(r.json.path), bytes);
  assert.equal(fs.statSync(r.json.path).mode & 0o777, 0o600);
});

// Invariant: a byte body that grows past the limit while streaming (no Content-Length) is refused with PAYLOAD_TOO_LARGE.
test('readBytesBody refuses a streamed body over the limit', async () => {
  const req = Object.assign(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), { headers: {} });
  await assert.rejects(readBytesBody(req, 10), (e) => e.code === 'PAYLOAD_TOO_LARGE');
  const ok = Object.assign(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), { headers: {} });
  assert.deepEqual(await readBytesBody(ok, 10), Buffer.from('abcd'));
});

// Invariant: DNS rebinding onto the backend's own port is refused: a hostname that is not loopback, naming this
// port, with a matching Origin gets 403 on api/mcp, every REST mutation and reads, and no handler runs.
test('a rebound Host on the backend port is refused with 403 on every route but health', async () => {
  const { port, manager, mcp, installer } = await boot();
  const host = `rebound.evil.test:${port}`;
  const headers = { ...JSON_HEADERS, host, origin: `http://${host}` };
  for (const route of MUTATING) {
    const r = await request(port, { method: route.method, path: route.path, body: route.body, headers });
    assert.equal(r.status, 403, `${route.method} ${route.path}`);
    assert.match(r.json.error, /loopback/);
  }
  assert.equal((await request(port, { path: '/api/browsers', headers: { host, origin: `http://${host}` } })).status, 403);
  assert.equal((await request(port, { path: '/api/chromium/install', headers: { host } })).status, 403, 'a rebound host cannot read the install log');
  assert.equal((await request(port, { path: '/', headers: { host } })).status, 403);
  assert.deepEqual(manager.calls, []);
  assert.deepEqual(mcp.calls, []);
  assert.deepEqual(installer.calls, []);
  assert.equal((await request(port, { path: '/api/health', headers: { host } })).status, 200, 'health is a constant answer');
});

// Invariant: loopback names on the backend port and a proxy's Host (another port) still work.
test('loopback Hosts on the backend port and proxied Hosts are accepted', async () => {
  const { port, mcp } = await boot();
  const body = '{"tool":"list_browsers","arguments":{}}';
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, 'cc.example:9', 'cc.example']) {
    const r = await request(port, { method: 'POST', path: '/api/mcp', headers: { ...JSON_HEADERS, host, origin: `http://${host}` }, body });
    assert.equal(r.status, 200, host);
  }
  assert.equal(mcp.calls.length, 5);
});

// Invariant: attach and connect are the panel's alone (no Origin or a foreign one is 403, before any handler),
// need JSON, refuse a bad address with 400 BAD_ENDPOINT, and otherwise answer 202 with the connecting summary at
// once; a connect that later fails does not affect the answer or the process.
test('attach and connect: panel-only, JSON, validated, 202', async () => {
  const { port, host, manager } = await boot();
  const same = { ...JSON_HEADERS, host, origin: `http://${host}` };
  const body = '{"address":"127.0.0.1:9222","via":"proxy"}';
  for (const p of ['/api/browsers/mine/attach', '/api/browsers/mine/connect']) {
    const noOrigin = await request(port, { method: 'POST', path: p, headers: JSON_HEADERS, body });
    assert.equal(noOrigin.status, 403, p);
    assert.match(noOrigin.json.error, /Origin/);
    assert.equal((await request(port, { method: 'POST', path: p, headers: { ...JSON_HEADERS, origin: 'http://evil.test' }, body })).status, 403);
    assert.equal((await request(port, { method: 'POST', path: p, headers: { ...same, 'content-type': 'text/plain' }, body })).status, 415);
  }
  assert.deepEqual(manager.calls, []);
  for (const bad of ['{"address":"10.0.0.1:9222","via":"proxy"}', '{"address":"127.0.0.1:9222","via":"lan"}', '{}']) {
    const r = await request(port, { method: 'POST', path: '/api/browsers/mine/attach', headers: same, body: bad });
    assert.equal(r.status, 400, bad);
    assert.match(r.json.error, /^BAD_ENDPOINT: /);
  }
  const ok = await request(port, { method: 'POST', path: '/api/browsers/mine/attach', headers: same, body });
  assert.equal(ok.status, 202);
  assert.equal(ok.json.browser.status, 'connecting');
  assert.deepEqual(ok.json.browser.attached, { address: '127.0.0.1:9222', via: 'proxy' });
  const again = await request(port, { method: 'POST', path: '/api/browsers/mine/connect', headers: same, body: '{}' });
  assert.equal(again.status, 202);
  assert.equal((await request(port, { method: 'POST', path: '/api/browsers/ghost/connect', headers: same, body: '{}' })).status, 400);
  assert.equal((await request(port, { path: '/api/health' })).status, 200);
});

// Invariant: the REST start route refuses an attached browser with 409 ATTACHED, and the opt-in route refuses it with
// 400; stop and delete need no Origin and reach the manager.
test('start, opt-in, stop and delete on an attached browser', async () => {
  const manager = fakeManager();
  manager.start = async () => { throw new CodedError('ATTACHED', "the user's own browser"); };
  manager.setAllowUnsandboxed = async () => { throw new CodedError('BAD_REQUEST', 'an attached browser'); };
  const { port, host } = await boot({ manager });
  const same = { ...JSON_HEADERS, host, origin: `http://${host}` };
  await request(port, { method: 'POST', path: '/api/browsers/mine/attach', headers: same, body: '{"address":"127.0.0.1:9222","via":"direct"}' });
  const started = await request(port, { method: 'POST', path: '/api/browsers/mine/start', headers: same, body: '{}' });
  assert.equal(started.status, 409);
  assert.match(started.json.error, /^ATTACHED: /);
  assert.equal((await request(port, { method: 'POST', path: '/api/browsers/mine/allow-unsandboxed', headers: same, body: '{"allow":true}' })).status, 400);
  assert.equal((await request(port, { method: 'POST', path: '/api/browsers/mine/stop', headers: JSON_HEADERS, body: '{}' })).status, 200);
  assert.equal((await request(port, { method: 'DELETE', path: '/api/browsers/mine', headers: JSON_HEADERS })).status, 200);
});
