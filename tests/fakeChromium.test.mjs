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

// Invariant: like Chromium, the fake changes a title without announcing it (getTargets shows it; no targetInfoChanged),
// and reports each tab's window, with newWindow targets getting a distinct one.
test('Fake.setTitle is silent; windows are reported per target', async () => {
  const f = await externalFake();
  try {
    const c = await f.agent();
    const events = [];
    c.on('event', (e) => events.push(e.method));
    await c.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos: [first] } = await c.send('Target.getTargets');
    const { targetId: far } = await c.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    const { targetId: near } = await c.send('Target.createTarget', { url: 'about:blank' });
    events.length = 0;
    await c.send('Fake.setTitle', { targetId: first.targetId, title: 'New' });
    const { targetInfos } = await c.send('Target.getTargets');
    assert.equal(targetInfos.find((t) => t.targetId === first.targetId).title, 'New');
    assert.ok(!events.includes('Target.targetInfoChanged'));
    const win = async (targetId) => (await c.send('Browser.getWindowForTarget', { targetId })).windowId;
    assert.equal(await win(first.targetId), await win(near));
    assert.notEqual(await win(far), await win(first.targetId));
    await assert.rejects(c.send('Browser.getWindowForTarget', { targetId: 'nope' }));
    c.close();
  } finally {
    await f.kill();
  }
});
