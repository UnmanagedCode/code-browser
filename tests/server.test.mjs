import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { CodedError } from '../src/errors.js';
import { CSP } from '../src/http.js';
import { buildRoutes } from '../src/routes.js';
import { JSON_HEADERS, listen, request, tmpDir } from './helpers.mjs';

const MUTATORS = ['create', 'start', 'stop', 'delete'];

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
        const r = await request(port, { ...route, headers });
        // A foreign Origin is refused first (403); otherwise the content type is (415).
        assert.equal(r.status, origin ? 403 : 415, `${route.method} ${route.path} ${type} ${origin}`);
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
      const r = await request(port, { ...route, headers: { ...JSON_HEADERS, origin } });
      assert.equal(r.status, 403, `${route.method} ${route.path} ${origin}`);
    }
  }
  assert.deepEqual(manager.calls, []);
  assert.deepEqual(mcp.calls, []);
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
