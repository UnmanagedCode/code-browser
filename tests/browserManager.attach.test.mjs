import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createBrowserManager } from '../src/browserManager.js';
import { PROTOCOL } from '../src/proxyProtocol.js';
import { fakeProxy } from './fakes/fakeProxy.mjs';
import { externalFake, listen, liveStack, sleep, tmpDir, waitFor } from './helpers.mjs';

const fakes = [];
let stacks = [];
afterEach(async () => {
  for (const s of stacks.splice(0)) await s.close();
  for (const f of fakes.splice(0)) await f.kill();
});

async function setup(opts = {}) {
  const stack = liveStack(opts);
  stacks.push(stack);
  await stack.manager.boot();
  return stack;
}
async function fake(opts) {
  const f = await externalFake(opts);
  fakes.push(f);
  return f;
}
const direct = (f) => ({ address: f.address, via: 'direct' });
const recordFile = (dataDir, n) => path.join(dataDir, 'attached', `${n}.json`);
const secretOf = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'proxy', PROTOCOL.rendezvous.backendFile), 'utf8')).secret;
const fakeState = async (f) => { const c = await f.agent(); const s = await c.send('Fake.getState'); c.close(); return s; };

// Invariant: a human's direct attach connects to their running browser and reports it as kind "attached", with a
// loopback endpoint, no sandbox claim, a record of {address, via}, and the proxy secret nowhere in what it exposes.
test('direct attach: connecting, then running as an attached browser', async () => {
  const { manager, dataDir } = await setup();
  const f = await fake();
  const done = manager.attach('mine', direct(f));
  assert.equal(manager.summary('mine').status, 'connecting');
  await done;
  const s = manager.summary('mine');
  assert.deepEqual(s, {
    name: 'mine', kind: 'attached', status: 'running', controller: 'agent', lastExit: null, cdpEndpoint: `http://${f.address}`,
    sandbox: null, allowUnsandboxed: false, sandboxUnavailable: false,
    attached: { address: f.address, via: 'direct', asksApproval: false }, attachError: null,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(recordFile(dataDir, 'mine'), 'utf8')), { address: f.address, via: 'direct' });
  const secret = secretOf(dataDir);
  for (const text of [JSON.stringify(manager.list()), JSON.stringify(manager.info('mine')), fs.readFileSync(recordFile(dataDir, 'mine'), 'utf8')]) {
    assert.ok(!text.includes(secret), 'the proxy secret never leaves the backend');
  }
  assert.deepEqual(manager.list().map((b) => b.name), ['mine']);
});

// Invariant: profile and attached names share one namespace; ensure never turns an attached name into a profile;
// one browser cannot be attached twice (same address, or the same browser id, which also catches code-browser's
// own launched Chromium).
test('collisions: names, addresses and browser ids', async () => {
  const { manager, dataDir } = await setup();
  const f = await fake();
  manager.create('prof');
  assert.throws(() => manager.attach('prof', direct(f)), (e) => e.code === 'EXISTS');
  await manager.attach('mine', direct(f));
  assert.throws(() => manager.create('mine'), (e) => e.code === 'EXISTS');
  assert.deepEqual(manager.ensure('mine'), { name: 'mine' });
  assert.ok(!fs.existsSync(path.join(dataDir, 'profiles', 'mine')));
  assert.throws(() => manager.attach('other', direct(f)), (e) => e.code === 'EXISTS' && /mine/.test(e.message));
  assert.ok(!fs.existsSync(recordFile(dataDir, 'other')));

  await manager.start('prof');
  const own = { address: `127.0.0.1:${manager.entry('prof').port}`, via: 'direct' };
  await assert.rejects(manager.attach('own', own), (e) => e.code === 'EXISTS' && /prof/.test(e.message));
  assert.equal(manager.summary('own').status, 'stopped');
  assert.match(manager.summary('own').attachError, /prof/);
});

// Invariant: bad attach input is refused synchronously with BAD_ENDPOINT and writes nothing.
test('bad attach input is BAD_ENDPOINT and writes no record', async () => {
  const { manager, dataDir } = await setup();
  for (const body of [{ address: '10.0.0.1:9222', via: 'direct' }, { address: '127.0.0.1:9222', via: 'lan' }, {}]) {
    assert.throws(() => manager.attach('mine', body), (e) => e.code === 'BAD_ENDPOINT');
  }
  assert.throws(() => manager.attach('../x', { address: '127.0.0.1:9222', via: 'direct' }), (e) => e.code === 'INVALID_NAME');
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'attached')), []);
});

// Invariant: in Chrome's approval mode the connect stays "connecting" until the person answers; Allow gives a
// running browser that asks approval (its endpoint is the id-less browser socket); Cancel gives stopped with
// Chrome's refusal; no answer in time gives stopped with a timeout error.
test('approval mode: pending, allowed, denied, timed out', async () => {
  const { manager } = await setup({});
  const f = await fake({ approval: true });
  const allowed = manager.attach('mine', direct(f));
  await waitFor(async () => (await f.pending()) === 1, { what: 'the held connection' });
  assert.equal(manager.summary('mine').status, 'connecting');
  assert.equal(manager.summary('mine').attached.asksApproval, true, 'known as soon as discovery sees the empty 404');
  await f.answer('allow');
  await allowed;
  const s = manager.summary('mine');
  assert.equal(s.status, 'running');
  assert.equal(s.attached.asksApproval, true);
  assert.equal(s.cdpEndpoint, `ws://${f.address}/devtools/browser`);

  await manager.stop('mine');
  const denied = assert.rejects(manager.connect('mine'), (e) => e.code === 'ATTACH_FAILED');
  await waitFor(async () => (await f.pending()) === 1, { what: 'the second held connection' });
  await f.answer('deny');
  await denied;
  const after = manager.summary('mine');
  assert.equal(after.status, 'stopped');
  assert.match(after.attachError, /cancelled in Chrome's 'Allow remote debugging\?' dialog/);
  assert.equal(after.attached.asksApproval, true, 'the last known approval mode is kept for the panel');
});

// Invariant: a connect nobody answers in Chrome fails after the approval timeout with a message saying so.
test('approval mode: no answer in time is an attachError', async () => {
  const dataDir = tmpDir();
  const manager = createBrowserManager({ dataDir, log: { warn() {} }, timeouts: { approval: 300 } });
  const f = await fake({ approval: true });
  await assert.rejects(manager.attach('mine', direct(f)), (e) => e.code === 'ATTACH_FAILED');
  assert.match(manager.summary('mine').attachError, /nobody allowed it .* within/);
  await manager.shutdown();
});

// Invariant: Disconnect while a connect waits on Chrome's dialog cancels it at once: stopped, no error, nothing held.
test('stop cancels a connect that waits on approval', async () => {
  const { manager } = await setup();
  const f = await fake({ approval: true });
  const pending = assert.rejects(manager.attach('mine', direct(f)), (e) => e.code === 'ATTACH_FAILED' && /cancelled/.test(e.message));
  await waitFor(async () => (await f.pending()) === 1, { what: 'the held connection' });
  await manager.stop('mine');
  await pending;
  assert.equal(manager.summary('mine').status, 'stopped');
  assert.equal(manager.summary('mine').attachError, null, 'a deliberate cancel is not an error');
  await waitFor(async () => (await f.pending()) === 0, { what: 'the held socket to close' });
});

// Invariant: stopping an attached browser only disconnects: the browser keeps running (it exits on Browser.close,
// so being alive proves none was sent), its tabs are intact, and it is not a crash.
test('stop disconnects without closing the browser or its tabs', async () => {
  const { manager } = await setup();
  const f = await fake();
  const agent = await f.agent();
  await agent.send('Target.createTarget', { url: 'https://user-tab.test/' });
  const before = (await agent.send('Fake.getState')).targets.map((t) => t.targetId);
  agent.close();
  await manager.attach('mine', direct(f));
  await manager.stop('mine');
  await sleep(100);
  assert.ok(f.alive());
  assert.deepEqual((await fakeState(f)).targets.map((t) => t.targetId), before);
  assert.equal(manager.summary('mine').status, 'stopped');
  assert.equal(manager.summary('mine').lastExit, null);
});

// Invariant: losing the connection unexpectedly (the browser quit) leaves the browser stopped with lastExit (the
// panel's "Disconnected"), and nothing reconnects it.
test('an unexpected close is Disconnected and not retried', async () => {
  const { manager } = await setup();
  const f = await fake();
  await manager.attach('mine', direct(f));
  const exited = new Promise((r) => manager.events.once('exited', r));
  await f.kill();
  await exited;
  const s = manager.summary('mine');
  assert.equal(s.status, 'stopped');
  assert.ok(s.lastExit);
  await sleep(100);
  assert.equal(manager.summary('mine').status, 'stopped');
});

// Invariant: only connect (the panel's Connect) reconnects an attached browser; start refuses it with ATTACHED.
test('start refuses an attached browser; connect reconnects', async () => {
  const { manager } = await setup();
  const f = await fake();
  await manager.attach('mine', direct(f));
  await manager.stop('mine');
  await assert.rejects(manager.start('mine'), (e) => e.code === 'ATTACHED');
  assert.equal(manager.summary('mine').status, 'stopped');
  await manager.connect('mine');
  assert.equal(manager.summary('mine').status, 'running');
  assert.throws(() => manager.connect('nobody'), (e) => e.code === 'NOT_FOUND');
  manager.create('prof');
  assert.throws(() => manager.connect('prof'), (e) => e.code === 'BAD_REQUEST');
});

// Invariant: a backend restart lists the attached browser as stopped and never connects it on its own.
test('a new manager lists the record stopped and does not auto-connect', async () => {
  const a = await setup();
  const f = await fake();
  await a.manager.attach('mine', direct(f));
  const b = await setup({ dataDir: a.dataDir });
  await sleep(100);
  assert.equal(b.manager.summary('mine').status, 'stopped');
  assert.deepEqual(b.manager.summary('mine').attached, { address: f.address, via: 'direct', asksApproval: null });
  assert.equal(b.manager.entry('mine'), undefined);
});

// Invariant: Forget removes only the record (the browser keeps running); shutdown closes only code-browser's
// sockets; the sandbox opt-in does not apply to an attached browser.
test('delete forgets the record only; shutdown leaves the browser; no sandbox opt-in', async () => {
  const { manager, dataDir } = await setup();
  const f = await fake();
  await manager.attach('mine', direct(f));
  await assert.rejects(manager.setAllowUnsandboxed('mine', true), (e) => e.code === 'BAD_REQUEST');
  assert.ok(!fs.existsSync(path.join(dataDir, 'settings', 'mine.json')));
  await manager.shutdown();
  await sleep(50);
  assert.ok(f.alive());
  await manager.connect('mine');
  await manager.delete('mine');
  assert.ok(!fs.existsSync(recordFile(dataDir, 'mine')));
  assert.throws(() => manager.summary('mine'), (e) => e.code === 'NOT_FOUND');
  await sleep(50);
  assert.ok(f.alive());
});

// Invariant: re-attaching an attached name re-points it: the record is replaced and the new target connected.
test('attach on an attached name re-points it', async () => {
  const { manager, dataDir } = await setup();
  const f1 = await fake();
  const f2 = await fake();
  await manager.attach('mine', direct(f1));
  await manager.attach('mine', direct(f2));
  assert.equal(manager.summary('mine').attached.address, f2.address);
  assert.equal(manager.summary('mine').status, 'running');
  assert.equal(manager.summary('mine').cdpEndpoint, `http://${f2.address}`, 'the live connection is the new target');
  await waitFor(async () => (await fakeState(f1)).connections === 1, { what: "the old browser's connection to close (1 = this probe)" });
  assert.equal((await fakeState(f2)).connections, 2, 'the backend and this probe');
  assert.deepEqual(JSON.parse(fs.readFileSync(recordFile(dataDir, 'mine'), 'utf8')), direct(f2));
});

// Invariant: a record that names a profile's name too is the profile's, and boot says so.
test('a name that is both a profile and a record is the profile, with a warning', async () => {
  const dataDir = tmpDir();
  const warns = [];
  const manager = createBrowserManager({ dataDir, log: { warn: (m) => warns.push(m) } });
  manager.create('both');
  fs.mkdirSync(path.join(dataDir, 'attached'), { recursive: true });
  fs.writeFileSync(recordFile(dataDir, 'both'), JSON.stringify({ address: '127.0.0.1:9222', via: 'direct' }));
  await manager.boot();
  assert.equal(manager.summary('both').kind, 'launched');
  assert.ok(warns.some((w) => /both a profile and an attached record/.test(w)));
  assert.equal(fs.statSync(recordFile(dataDir, 'both')).mode & 0o777, 0o600, 'boot tightens records');
});

// ---- the session over an attached browser ----

// Invariant: an attached browser's existing tabs are listed but none is made active or brought to the front; a
// tab is activated in the browser only when someone starts watching it; a tab the agent opens becomes active; and
// closing the last tab opens nothing.
test('session: user tabs stay in the background until watched', async () => {
  const stack = await setup();
  await stack.listen();
  const f = await fake();
  await stack.manager.attach('mine', direct(f));
  const session = stack.manager.session('mine');
  await waitFor(() => session.snapshot().tabs.length === 1, { what: 'seeded tab' });
  assert.equal(session.snapshot().activeTabId, null);
  assert.equal(stack.manager.info('mine').activeTargetId, null);
  const [tab] = session.snapshot().tabs;
  await waitFor(async () => (await fakeState(f)).sessions.length >= 1, { what: 'tab attached' });
  await sleep(100);
  assert.equal((await fakeState(f)).sessions.length, 1, 'exactly one page session per seeded tab');
  assert.deepEqual((await fakeState(f)).activations, []);

  session.activateTab(tab.targetId);
  await sleep(50);
  assert.deepEqual((await fakeState(f)).activations, [], 'selecting a tab with nobody watching does not raise it');
  const v = await stack.viewer();
  v.send({ msg: 'view', name: 'mine', maxWidth: 800, maxHeight: 600 });
  await v.waitFor((x) => x.frames.length >= 1, 'a frame');
  // Fake.getState travels on another connection than the activation, so poll for it.
  await waitFor(async () => (await fakeState(f)).activations.length > 0, { what: 'the activation' });
  assert.deepEqual((await fakeState(f)).activations, [tab.targetId]);

  const agent = await f.agent();
  const { targetId } = await agent.send('Target.createTarget', { url: 'about:blank' });
  await waitFor(() => session.snapshot().activeTabId === targetId, { what: "the agent's tab to become active" });
  await agent.send('Target.closeTarget', { targetId });
  await agent.send('Target.closeTarget', { targetId: tab.targetId });
  await waitFor(() => session.snapshot().tabs.length === 0, { what: 'tabs to close' });
  await sleep(100);
  assert.equal((await agent.send('Fake.getState')).targets.length, 0, 'no about:blank is opened in a user browser');
  agent.close();
});

// ---- cancellation, refusal before queueing, cleanup after registration ----

// A server that starts an HTTP answer and then drips a header byte every 50 ms, forever.
async function drip() {
  const sockets = new Set();
  const server = http.createServer();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('request', (req, res) => {
    res.socket.write('HTTP/1.1 200 OK\r\nX-Drip: ');
    const timer = setInterval(() => res.socket.write('x'), 50);
    res.socket.on('close', () => clearInterval(timer));
  });
  const port = await listen(server);
  return { address: `127.0.0.1:${port}`, open: () => sockets.size, close: () => { server.close(); for (const s of sockets) s.destroy(); } };
}

// Invariant: stop cancels a connect at once while discovery is still waiting on a slow answer: stopped, no error, and
// the discovery socket is closed.
test('stop cancels a connect during discovery', async () => {
  const { manager } = await setup();
  const d = await drip();
  try {
    const pending = assert.rejects(manager.attach('mine', { address: d.address, via: 'direct' }), (e) => /cancelled/.test(e.message));
    await waitFor(() => d.open() === 1, { what: 'the discovery request' });
    const t0 = Date.now();
    await manager.stop('mine');
    await pending;
    assert.ok(Date.now() - t0 < 1000, `stop took ${Date.now() - t0} ms`);
    assert.equal(manager.summary('mine').status, 'stopped');
    assert.equal(manager.summary('mine').attachError, null);
    await waitFor(() => d.open() === 0, { what: 'the discovery socket to close' });
  } finally { d.close(); }
});

// Invariant: Forget cancels a connect at once while the proxy dial is still waiting on a proxy that never answers,
// and the proxied socket is closed.
test('delete cancels a connect during the proxy dial', async () => {
  const { manager, dataDir } = await setup();
  const proxy = await fakeProxy(dataDir, { mode: 'blackhole' });
  try {
    const pending = assert.rejects(manager.attach('mine', { address: '127.0.0.1:9222', via: 'proxy' }), (e) => /cancelled/.test(e.message));
    await waitFor(() => proxy.connections() === 1, { what: 'the proxy dial' });
    const t0 = Date.now();
    await manager.delete('mine');
    await pending;
    assert.ok(Date.now() - t0 < 1000, `delete took ${Date.now() - t0} ms`);
    assert.throws(() => manager.summary('mine'), (e) => e.code === 'NOT_FOUND');
    await waitFor(() => proxy.connections() === 0, { what: 'the proxied socket to close' });
  } finally { proxy.close(); }
});

// Invariant: re-attaching cancels a connect stuck in discovery and connects the new target without waiting it out.
test('re-attach cancels a stuck connect', async () => {
  const { manager } = await setup();
  const d = await drip();
  const f = await fake();
  try {
    const stuck = assert.rejects(manager.attach('mine', { address: d.address, via: 'direct' }), (e) => /cancelled/.test(e.message));
    await waitFor(() => d.open() === 1, { what: 'the discovery request' });
    const t0 = Date.now();
    await manager.attach('mine', direct(f));
    await stuck;
    assert.ok(Date.now() - t0 < 1500, `re-attach took ${Date.now() - t0} ms`);
    assert.equal(manager.summary('mine').cdpEndpoint, `http://${f.address}`);
  } finally { d.close(); }
});

// Invariant: start and the sandbox opt-in, which apply only to launched browsers, refuse an attached name at once,
// even while its connect waits on Chrome's approval dialog (they do not queue behind it).
test('start and the opt-in refuse an attached name without queueing', async () => {
  const { manager } = await setup();
  const f = await fake({ approval: true });
  const pending = assert.rejects(manager.attach('mine', direct(f)), (e) => /cancelled/.test(e.message));
  await waitFor(async () => (await f.pending()) === 1, { what: 'the held connection' });
  const t0 = Date.now();
  await assert.rejects(manager.start('mine'), (e) => e.code === 'ATTACHED');
  await assert.rejects(manager.setAllowUnsandboxed('mine', true), (e) => e.code === 'BAD_REQUEST');
  assert.ok(Date.now() - t0 < 500, `refusals took ${Date.now() - t0} ms`);
  assert.equal(manager.summary('mine').status, 'connecting');
  await manager.stop('mine');
  await pending;
});

// Invariant: a failure after the attached browser is registered (here createSession throws) removes it, closes its CDP
// connection and its tunnel, and leaves it stopped with attachError; summary and info agree.
for (const via of ['direct', 'proxy']) {
  test(`a session that fails to start leaves nothing behind (${via})`, async () => {
    const dataDir = path.join(tmpDir(), '.code-browser');
    let captured = null;
    const manager = createBrowserManager({
      dataDir, log: { warn() {} }, env: { ...process.env, CODE_BROWSER_PROXY_DIAL_HOST: '127.0.0.1' },
      createSession: (entry) => { captured = entry; throw new Error('boom'); },
    });
    await manager.boot();
    const f = await fake();
    const proxy = via === 'proxy' ? await fakeProxy(dataDir) : null;
    try {
      await assert.rejects(manager.attach('mine', { address: f.address, via }), (e) => e.code === 'ATTACH_FAILED' && /boom/.test(e.message));
      const s = manager.summary('mine');
      assert.equal(s.status, 'stopped');
      assert.match(s.attachError, /boom/);
      assert.equal(s.lastExit, null, 'a failed connect is not a disconnect');
      assert.equal(manager.entry('mine'), undefined);
      assert.throws(() => manager.info('mine'), (e) => e.code === 'NOT_RUNNING');
      assert.ok(captured.cdp.closed, 'the CDP connection is closed');
      if (via === 'proxy') assert.ok(captured.tunnel.closed, 'the tunnel is closed');
      await waitFor(async () => (await fakeState(f)).connections === 1, { what: "the backend's connection to go (1 = this probe)" });
    } finally {
      proxy?.close();
      await manager.shutdown();
    }
  });
}
