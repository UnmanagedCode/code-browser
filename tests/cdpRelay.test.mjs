import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { CLOSE_CONTROLLED, CLOSE_UPSTREAM, createCdpRelay, relayUrl } from '../src/cdpRelay.js';
import { fakeRelayManager, HOLD } from './fakes/fakeUpstream.mjs';
import { idleInstaller, listen, sleep, tmpDir, waitFor } from './helpers.mjs';

const TOKEN = 'ab'.repeat(32);
const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function stack({ names = ['a'], ...options } = {}) {
  const manager = fakeRelayManager(names);
  const relay = createCdpRelay({ manager, token: TOKEN, log: { error() {} }, pingMs: 60_000, ...options });
  const server = createApp({ manager, mcp: {}, installer: idleInstaller, distDir: path.join(tmpDir(), 'dist'), onRelayUpgrade: relay.handleUpgrade });
  const port = await listen(server);
  cleanup.push(() => { relay.close(); server.close(); });
  return { manager, relay, port, up: (name = 'a') => manager.get(name).cdp };
}

// A relay client: every message it receives, its close code and reason, or the refused upgrade's status and body.
function client(port, name = 'a', { token = TOKEN, wsOptions = {} } = {}) {
  const ws = new WebSocket(relayUrl(port, name), { headers: token ? { authorization: `Bearer ${token}` } : {}, ...wsOptions });
  const c = { ws, messages: [] };
  c.opened = new Promise((resolve, reject) => {
    ws.once('open', () => resolve(c));
    ws.once('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => reject(Object.assign(new Error(`refused ${res.statusCode}`), { status: res.statusCode, body })));
    });
    ws.once('error', reject);
  });
  c.opened.catch(() => {});
  c.closed = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  ws.on('message', (d) => c.messages.push(JSON.parse(d.toString())));
  c.send = (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  c.reply = (id) => waitFor(() => c.messages.find((m) => m.id === id), { what: `reply ${id}` });
  cleanup.push(() => ws.terminate());
  return c;
}
const open = (...a) => client(...a).opened;

// Invariant: each client gets its own browser-target session, and a command with no sessionId travels on it.
test('each client gets its own root, and session-less commands go on it', async () => {
  const { port, up } = await stack();
  const a = await open(port);
  const b = await open(port);
  const roots = up().of('Target.attachToBrowserTarget');
  assert.equal(roots.length, 2);
  assert.ok(roots.every((m) => m.via === 'send' && m.sessionId === undefined), 'roots are attached from the backend root');
  a.send({ id: 1, method: 'Browser.getVersion' });
  b.send({ id: 1, method: 'Browser.getVersion' });
  await a.reply(1);
  await b.reply(1);
  assert.deepEqual(up().of('Browser.getVersion').map((m) => m.sessionId).sort(), ['root-1', 'root-2']);
});

// Invariant: a reply carries the client's own id, and the root's sessionId never reaches the client.
test('replies keep the client id and never show the root sessionId', async () => {
  const { port, up } = await stack();
  up().handlers['Target.getTargetInfo'] = () => ({ result: { targetInfo: { targetId: 'b' } } });
  up().handlers['Runtime.evaluate'] = () => ({ error: { code: -32000, message: 'boom' } });
  const a = await open(port);
  a.send({ id: 41, method: 'Target.getTargetInfo' });
  a.send({ id: 42, method: 'Runtime.evaluate', params: { expression: '1' } });
  assert.deepEqual(await a.reply(41), { id: 41, result: { targetInfo: { targetId: 'b' } } });
  assert.deepEqual(await a.reply(42), { id: 42, error: { code: -32000, message: 'boom' } });
});

// Invariant: an upstream event goes to the client owning its session only (root events lose the sessionId; child events
// keep it); events with no session or on the backend's own sessions go to nobody and are not unknown; anything else is
// dropped and counted.
test('events reach only their owner; backend and root events reach nobody', async () => {
  const { port, up, relay, manager } = await stack();
  const a = await open(port);
  const b = await open(port);
  manager.get('a').backendSessions.add('backend-page');
  up().event('Target.attachedToTarget', { sessionId: 'child-a', targetInfo: { targetId: 't1' } }, 'root-1');
  up().event('Page.loadEventFired', { t: 1 }, 'child-a');
  up().event('Target.targetCreated', { targetInfo: {} });
  up().event('Page.screencastFrame', {}, 'backend-page');
  up().event('Page.loadEventFired', { t: 2 }, 'root-2');
  await waitFor(() => b.messages.length === 1 && a.messages.length === 2, { what: 'events' });
  await sleep(20);
  assert.deepEqual(a.messages, [
    { method: 'Target.attachedToTarget', params: { sessionId: 'child-a', targetInfo: { targetId: 't1' } } },
    { method: 'Page.loadEventFired', params: { t: 1 }, sessionId: 'child-a' },
  ]);
  assert.deepEqual(b.messages, [{ method: 'Page.loadEventFired', params: { t: 2 } }]);
  assert.equal(relay.stats().unknownDropped, 0);
  up().event('Page.loadEventFired', {}, 'nobody');
  assert.equal(relay.stats().unknownDropped, 1);
});

// Invariant: a command naming a session that is not the client's own (another client's, the backend's, unknown) is
// answered with Chrome's own "not found" error and nothing goes upstream.
test("a foreign or backend sessionId gets -32001 and nothing is sent", async () => {
  const { port, up, manager } = await stack();
  manager.get('a').backendSessions.add('backend-page');
  const a = await open(port);
  await open(port);
  up().event('Target.attachedToTarget', { sessionId: 'child-b' }, 'root-2');
  const before = up().sent.length;
  for (const [id, sessionId] of [[1, 'child-b'], [2, 'backend-page'], [3, 'nobody'], [4, 'root-1']]) {
    a.send({ id, method: 'Runtime.evaluate', sessionId });
    assert.deepEqual(await a.reply(id), { id, error: { code: -32001, message: 'Session with given id not found.' }, sessionId });
  }
  assert.equal(up().sent.length, before);
});

// Invariant: methods that would close or crash the shared browser, the non-flat transport, and detaching a session
// that is not the client's own are refused without anything reaching the browser.
test('Browser.close/crash, non-flatten attach and an unowned detach are refused upstream-free', async () => {
  const { port, up } = await stack();
  const a = await open(port);
  const before = up().sent.length;
  const refused = [
    { method: 'Browser.close' }, { method: 'Browser.crash' }, { method: 'Browser.crashGpuProcess' },
    { method: 'Target.sendMessageToTarget', params: { message: '{}', sessionId: 'x' } },
    { method: 'Target.attachToTarget', params: { targetId: 't' } },
    { method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: false } },
    { method: 'Target.autoAttachRelated', params: { targetId: 't', waitForDebuggerOnStart: false } },
    { method: 'Target.detachFromTarget', params: { sessionId: 'backend' } },
    { method: 'Target.detachFromTarget', params: { targetId: 't' } },
  ];
  for (const [i, m] of refused.entries()) {
    a.send({ id: i + 1, ...m });
    const r = await a.reply(i + 1);
    assert.equal(r.error?.code, -32000, m.method);
  }
  assert.equal(up().sent.length, before);
  a.send({ id: 99, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } });
  assert.ok((await a.reply(99)).result, 'the flat form passes');
});

// Invariant: a client's sessions from every route (auto-attach events, attach results) are its own until Chrome detaches
// them; then they are not.
test('ownership follows attach events and results, and ends on detach', async () => {
  const { port, up } = await stack();
  up().handlers['Target.attachToTarget'] = () => ({ result: { sessionId: 'explicit' } });
  const a = await open(port);
  up().event('Target.attachedToTarget', { sessionId: 'auto' }, 'root-1');
  up().event('Target.attachedToTarget', { sessionId: 'nested' }, 'auto');
  a.send({ id: 1, method: 'Target.attachToTarget', params: { targetId: 't', flatten: true } });
  await a.reply(1);
  for (const [id, sessionId] of [[2, 'auto'], [3, 'nested'], [4, 'explicit']]) {
    a.send({ id, method: 'Runtime.enable', sessionId });
    assert.ok((await a.reply(id)).result, sessionId);
  }
  up().event('Target.detachedFromTarget', { sessionId: 'nested' }, 'auto');
  a.send({ id: 5, method: 'Runtime.enable', sessionId: 'nested' });
  assert.equal((await a.reply(5)).error.code, -32001);
  a.send({ id: 6, method: 'Target.detachFromTarget', params: { sessionId: 'auto' } });
  assert.ok((await a.reply(6)).result, 'detaching an owned session is allowed');
});

// Invariant: answers and events reach the client in the order the browser sent them.
test('a reply and the events after it keep their order', async () => {
  const { port, up } = await stack();
  up().handlers['Page.enable'] = () => HOLD;
  const a = await open(port);
  up().event('Target.attachedToTarget', { sessionId: 'p' }, 'root-1');
  a.send({ id: 7, method: 'Page.enable', sessionId: 'p' });
  await waitFor(() => up().of('Page.enable').length === 1, { what: 'Page.enable upstream' });
  up().answer();
  up().event('Runtime.executionContextCreated', { context: { id: 1 } }, 'p');
  await waitFor(() => a.messages.length === 3, { what: 'reply and event' });
  assert.deepEqual(a.messages.slice(1).map((m) => m.id ?? m.method), [7, 'Runtime.executionContextCreated']);
});

// Invariant: when a client leaves, its sessions are detached children first, each on its parent, its root last on the
// backend root; the browser is never closed; its pending commands are dropped and a late answer goes nowhere.
test('close detaches children-first then the root, drops pending, never closes the browser', async () => {
  const { port, up, relay } = await stack();
  up().handlers['Runtime.evaluate'] = () => HOLD;
  const a = await open(port);
  up().event('Target.attachedToTarget', { sessionId: 'page' }, 'root-1');
  up().event('Target.attachedToTarget', { sessionId: 'frame' }, 'page');
  a.send({ id: 1, method: 'Runtime.evaluate', sessionId: 'page' });
  await waitFor(() => up().heldIds().length === 1, { what: 'the held evaluate' });
  a.ws.close();
  await waitFor(() => relay.stats().clients === 0, { what: 'the client to leave' });
  assert.deepEqual(up().heldIds(), [], 'the pending command was dropped');
  assert.deepEqual(up().of('Target.detachFromTarget').map((m) => [m.params.sessionId, m.sessionId]), [['frame', 'page'], ['page', 'root-1'], ['root-1', undefined]]);
  assert.equal(up().of('Browser.close').length, 0);
  up().event('Page.loadEventFired', {}, 'page');
  assert.equal(relay.stats().unknownDropped, 0, 'late events of a released session are not unknown');
});

// Invariant: while a person holds control a connect is refused with 409 BROWSER_CONTROLLED before anything is attached.
test('a human at upgrade time: 409 and no attach', async () => {
  const { port, up, manager } = await stack();
  manager.get('a').session.controller.take('viewer-1');
  await assert.rejects(open(port), (e) => e.status === 409 && /^BROWSER_CONTROLLED: /.test(e.body));
  assert.equal(up().of('Target.attachToBrowserTarget').length, 0);
});

// Invariant: a take that lands while the root is being attached refuses the connect and detaches that root.
test('a take during the attach: 409 and the root is detached', async () => {
  const { port, up, manager } = await stack();
  up().handlers['Target.attachToBrowserTarget'] = () => HOLD;
  const c = client(port);
  await waitFor(() => up().heldIds().length === 1, { what: 'the attach' });
  manager.get('a').session.controller.take('viewer-1');
  up().answer(undefined, { result: { sessionId: 'late-root' } });
  await assert.rejects(c.opened, (e) => e.status === 409 && /BROWSER_CONTROLLED/.test(e.body));
  await waitFor(() => up().of('Target.detachFromTarget').some((m) => m.params.sessionId === 'late-root'), { what: 'the root detach' });
});

// Invariant: taking control drops every client of that browser with 4001 and a reason naming BROWSER_CONTROLLED, its
// sessions are detached, and after a release a new connect succeeds. Another browser's clients are untouched.
test('a take mid-command drops the client with 4001; after release a connect works', async () => {
  const { port, up, manager, relay } = await stack({ names: ['a', 'b'] });
  up().handlers['Runtime.evaluate'] = () => HOLD;
  const a = await open(port);
  const other = await open(port, 'b');
  a.send({ id: 1, method: 'Runtime.evaluate' });
  await waitFor(() => up().heldIds().length === 1, { what: 'the held evaluate' });
  manager.get('a').session.controller.take('viewer-1');
  const closed = await a.closed;
  assert.equal(closed.code, CLOSE_CONTROLLED);
  assert.match(closed.reason, /^BROWSER_CONTROLLED: /);
  assert.ok(up().of('Target.detachFromTarget').some((m) => m.params.sessionId === 'root-1'));
  assert.equal(relay.stats().clients, 1, "the other browser's client stays");
  assert.equal(other.ws.readyState, WebSocket.OPEN);
  manager.get('a').session.controller.release('viewer-1');
  await open(port);
});

// Invariant: when the browser's upstream connection closes, its clients are closed with 4002 and a CDP_CLOSED reason, and
// a command in flight gets no answer of its own: the close reason is its only answer.
test('an upstream close ends its clients with 4002 and no per-command answer', async () => {
  const { port, up } = await stack();
  up().handlers['Runtime.evaluate'] = () => HOLD;
  const a = await open(port);
  a.send({ id: 1, method: 'Runtime.evaluate' });
  await waitFor(() => up().heldIds().length === 1, { what: 'the held evaluate' });
  up().drop();
  const closed = await a.closed;
  assert.equal(closed.code, CLOSE_UPSTREAM);
  assert.match(closed.reason, /^CDP_CLOSED: /);
  assert.deepEqual(a.messages.filter((m) => m.id === 1), []);
});

// Invariant: what is not a CDP command envelope closes the client: binary 1003, not JSON or not an envelope 1007, a frame
// over the payload limit 1009. Nothing malformed reaches the browser.
test('malformed, binary and oversize frames close the client', async () => {
  const { port, up } = await stack({ maxPayload: 1024 });
  const cases = [
    [(c) => c.ws.send(Buffer.from('{}'), { binary: true }), 1003],
    [(c) => c.send('{nope'), 1007],
    [(c) => c.send({ method: 'X' }), 1007],
    [(c) => c.send({ id: 1.5, method: 'X' }), 1007],
    [(c) => c.send({ id: 1, method: 'X', sessionId: 5 }), 1007],
    [(c) => c.send({ id: 1, method: 'X', params: [] }), 1007],
    [(c) => c.send([1]), 1007],
    [(c) => c.send({ id: 1, method: 'X', params: { pad: 'x'.repeat(2048) } }), 1009],
  ];
  for (const [act, code] of cases) {
    const c = await open(port);
    act(c);
    assert.equal((await c.closed).code, code);
  }
  assert.equal(up().sent.filter((m) => m.via === 'forward').length, 0);
});

// Invariant: a client that leaves more than the high-water mark unread is dropped with 1008.
test('a slow reader is dropped with 1008', async () => {
  const { port, up } = await stack({ highWater: 64 * 1024 });
  const a = await open(port);
  a.ws._socket.pause();
  const pad = 'x'.repeat(256 * 1024);
  for (let i = 0; i < 64 && a.ws.readyState === WebSocket.OPEN; i += 1) {
    up().event('Page.loadEventFired', { pad }, 'root-1');
    await sleep(0);
  }
  a.ws._socket.resume();
  assert.equal((await a.closed).code, 1008);
});

// Invariant: a browser takes at most `maxClients` relay clients; the next is refused with 503 RELAY_FULL.
test('the per-browser cap answers 503', async () => {
  const { port } = await stack({ names: ['a', 'b'], maxClients: 2 });
  await open(port);
  await open(port);
  await assert.rejects(open(port), (e) => e.status === 503 && /^RELAY_FULL: /.test(e.body));
  await open(port, 'b');
});

// Invariant: a client that stops answering pings is terminated and its sessions detached.
test('a client that misses a pong is dropped', async () => {
  const { port, up, relay } = await stack({ pingMs: 20 });
  await open(port, 'a', { wsOptions: { autoPong: false } });
  await waitFor(() => relay.stats().clients === 0, { what: 'the silent client to be dropped', timeout: 2000 });
  assert.ok(up().of('Target.detachFromTarget').some((m) => m.params.sessionId === 'root-1'));
});

// Invariant: relay.close (backend shutdown) closes every client with 1001.
test('shutdown closes clients with 1001', async () => {
  const { port, relay } = await stack();
  const a = await open(port);
  relay.close();
  assert.equal((await a.closed).code, 1001);
});

// Invariant: the upgrade refuses in order (token, name, running) with a text body naming the code; the token check runs
// before any manager method.
test('upgrade refusals: 401 before the manager, 404 unknown, 409 stopped', async () => {
  const { port, manager } = await stack();
  for (const token of [null, 'cd'.repeat(32), 'nothex']) {
    await assert.rejects(open(port, 'a', { token }), (e) => e.status === 401 && /^UNAUTHORIZED: /.test(e.body));
  }
  assert.deepEqual(manager.calls, []);
  await assert.rejects(open(port, 'nope'), (e) => e.status === 404 && /^NOT_FOUND: /.test(e.body));
  await assert.rejects(open(port, 'Bad_Name'), (e) => e.status === 400 && /^INVALID_NAME: /.test(e.body));
});

// Invariant: a browser that exists but is not running is refused with 409 NOT_RUNNING.
test('a stopped browser is refused with 409 NOT_RUNNING', async () => {
  const manager = fakeRelayManager([], { stopped: ['s'] });
  const relay = createCdpRelay({ manager, token: TOKEN, log: { error() {} } });
  const server = createApp({ manager, mcp: {}, installer: idleInstaller, distDir: tmpDir(), onRelayUpgrade: relay.handleUpgrade });
  const port = await listen(server);
  cleanup.push(() => { relay.close(); server.close(); });
  await assert.rejects(open(port, 's'), (e) => e.status === 409 && /^NOT_RUNNING: /.test(e.body));
});
