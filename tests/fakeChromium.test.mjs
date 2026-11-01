import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { externalFake, request } from './helpers.mjs';

// The upgrade's status, 'open', or 'held' when nothing answers within a bound (a removed guard lets the request fall
// into approval mode's held branch, which must fail the test rather than hang it).
const upgrade = (url, headers) => new Promise((resolve) => {
  const ws = new WebSocket(url, { headers });
  const timer = setTimeout(() => { ws.terminate(); resolve('held'); }, 2000);
  const done = (v) => { clearTimeout(timer); resolve(v); };
  ws.on('unexpected-response', (_req, res) => { done(res.statusCode); res.resume(); });
  ws.on('open', () => { ws.close(); done('open'); });
  ws.on('error', () => {});
});

// Invariant: the fake keeps Chromium's devtools guards, which the attach tests rely on: a Host that is not an IP or
// localhost gets 500, and a WebSocket upgrade with an Origin gets 403 (in approval mode too, before any approval).
for (const approval of [false, true]) {
  test(`the fake enforces the Host and Origin guards (approval ${approval})`, async () => {
    const f = await externalFake({ approval });
    try {
      assert.equal((await request(f.port, { path: '/json/version', headers: { host: `evil.test:${f.port}` } })).status, 500);
      assert.notEqual((await request(f.port, { path: '/json/version', headers: { host: `localhost:${f.port}` } })).status, 500);
      const path = approval ? '/devtools/browser' : f.wsPath;
      assert.equal(await upgrade(`ws://${f.address}${path}`, { origin: 'http://evil.test' }), 403);
      assert.equal(await upgrade(`ws://${f.address}${path}`, { host: `evil.test:${f.port}` }), 500);
      assert.equal(await f.pending(), 0, 'a refused upgrade is never held for approval');
      if (!approval) assert.equal(await upgrade(`ws://${f.address}${path}`, {}), 'open');
    } finally {
      await f.kill();
    }
  });
}
