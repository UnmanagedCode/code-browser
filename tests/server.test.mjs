import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { CodedError } from '../src/errors.js';
import { CSP } from '../src/http.js';
import { buildRoutes } from '../src/routes.js';
import { JSON_HEADERS, listen, rawExchange, request, tmpDir } from './helpers.mjs';

const MUTATORS = ['create', 'start', 'stop', 'delete', 'setAllowUnsandboxed'];

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
  };
}

const servers = [];
async function boot({ manager = fakeManager(), dist, mcp } = {}) {
  const mcpStub = mcp ?? { calls: [], async handle(body) { this.calls.push(body); return { result: 'ok' }; } };
  const server = createApp({ manager, mcp: mcpStub, distDir: dist ?? path.join(tmpDir(), 'missing') });
  const port = await listen(server);
  servers.push(server);
  return { port, manager, mcp: mcpStub, host: `127.0.0.1:${port}` };
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
  const { port, manager } = await boot({ manager: fakeManager({ hang: true }) });
  const r = await request(port, { path: '/api/health' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.deepEqual(manager.calls, []);
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
  { method: 'DELETE', path: '/api/browsers/x', body: undefined },
];

// Invariant: a state-changing request without a JSON content type (the only kind a no-cors page can send)
// is refused with 415 before any handler runs, with or without a foreign Origin.
test('non-JSON content types are refused with 415 and run nothing', async () => {
  const { port, manager, mcp } = await boot();
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
});

// Invariant: a foreign Origin is refused with 403 even when the body is valid JSON, api/mcp included.
test('a foreign or mismatched Origin is refused with 403 even with JSON', async () => {
  const { port, manager, mcp } = await boot();
  for (const route of MUTATING) {
    for (const origin of ['http://evil.test', 'http://127.0.0.1:1']) {
      const r = await request(port, { method: route.method, path: route.path, body: route.body, headers: { ...JSON_HEADERS, origin } });
      assert.equal(r.status, 403, `${route.method} ${route.path} ${origin}`);
    }
  }
  assert.deepEqual(manager.calls, []);
  assert.deepEqual(mcp.calls, []);
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
  const { port, manager } = await boot();
  const gets = buildRoutes({ manager, mcp: {} }).filter((r) => r.method === 'GET');
  assert.ok(gets.length >= 2);
  for (const route of gets) {
    assert.equal(route.mutating, undefined, `${route.path} must not be marked mutating`);
  }
  for (const p of ['/api/health', '/api/browsers', '/api/browsers/x/start', '/api/browsers/x/stop', '/api/browsers/x', '/api/mcp']) {
    await request(port, { path: p, headers: { origin: 'http://evil.test' } });
    await request(port, { path: p });
  }
  for (const m of MUTATORS) assert.ok(!manager.calls.includes(m), `${m} was called by a GET`);
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

// Invariant: DNS rebinding onto the backend's own port is refused: a hostname that is not loopback, naming this
// port, with a matching Origin gets 403 on api/mcp, every REST mutation and reads, and no handler runs.
test('a rebound Host on the backend port is refused with 403 on every route but health', async () => {
  const { port, manager, mcp } = await boot();
  const host = `rebound.evil.test:${port}`;
  const headers = { ...JSON_HEADERS, host, origin: `http://${host}` };
  for (const route of MUTATING) {
    const r = await request(port, { method: route.method, path: route.path, body: route.body, headers });
    assert.equal(r.status, 403, `${route.method} ${route.path}`);
    assert.match(r.json.error, /loopback/);
  }
  assert.equal((await request(port, { path: '/api/browsers', headers: { host, origin: `http://${host}` } })).status, 403);
  assert.equal((await request(port, { path: '/', headers: { host } })).status, 403);
  assert.deepEqual(manager.calls, []);
  assert.deepEqual(mcp.calls, []);
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
