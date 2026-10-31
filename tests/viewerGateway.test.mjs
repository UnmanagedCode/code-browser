import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { liveStack, rawExchange, sleep, waitFor } from './helpers.mjs';

let stack;
afterEach(async () => { await stack?.close(); stack = null; });

async function boot(opts) {
  stack = liveStack(opts);
  const session = await stack.start();
  await stack.listen();
  await waitFor(() => session.snapshot().activeTabId, { what: 'initial tab' });
  const agent = await stack.agent();
  await waitFor(async () => (await agent.send('Fake.getState')).sessions.length >= 1, { what: 'tab attached' });
  return { session, agent };
}
const view = async (v, name = 'a') => {
  v.send({ msg: 'view', name, maxWidth: 800, maxHeight: 600 });
  await v.waitFor((x) => x.last('state'), 'state');
};
const click = { msg: 'input', kind: 'mouse', action: 'down', x: 5, y: 5, button: 'left', clickCount: 1 };

// Invariant: a WebSocket upgrade without an Origin, with a foreign Origin, or on another path never reaches the gateway.
test('upgrade is refused for a missing, mismatched or foreign Origin and for other paths', async () => {
  await boot();
  const attempt = (opts, p = '/api/ws') => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${stack.port}${p}`, opts);
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode); res.resume(); });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => {});
  });
  assert.equal(await attempt({ headers: { origin: 'http://evil.test' } }), 403);
  assert.equal(await attempt({ headers: { origin: 'http://127.0.0.1:1' } }), 403);
  assert.equal(await attempt({}), 403, 'no Origin');
  assert.equal(await attempt({ headers: { origin: `http://127.0.0.1:${stack.port}` } }, '/other'), 404);
  assert.equal(await attempt({ headers: { origin: `http://127.0.0.1:${stack.port}` } }), 'open');
});

// Invariant: hello gives the browser list; view gives state and a screencast frame with the CDP metadata.
test('hello then view yields browsers, state and a binary frame', async () => {
  await boot();
  const v = await stack.viewer();
  await v.waitFor((x) => x.last('browsers'), 'browsers');
  assert.deepEqual(v.last('browsers').list.map((b) => b.name), ['a']);
  await view(v);
  const state = v.last('state');
  assert.equal(state.status, 'running');
  assert.deepEqual(state.controller, { kind: 'agent' });
  assert.equal(state.tabs.length, 1);
  await v.waitFor((x) => x.frames.length >= 1, 'first frame');
  assert.equal(v.frames[0].header.tabId, state.activeTabId);
  assert.equal(v.frames[0].header.meta.deviceWidth, 100);
});

// Invariant: frame flow control: one frame per ack, so a viewer that does not ack gets no more frames.
test('a viewer receives the next frame only after acking', async () => {
  const { agent } = await boot();
  const v = await stack.viewer();
  await view(v);
  await v.waitFor((x) => x.frames.length === 1, 'first frame');
  const tab = v.last('state').activeTabId;
  await agent.send('Fake.emitFrame', { targetId: tab });
  await sleep(150);
  assert.equal(v.frames.length, 1, 'no ack yet, so the newest frame is held back');
  v.send({ msg: 'ack', seq: v.frames[0].header.seq });
  await v.waitFor((x) => x.frames.length === 2, 'second frame after ack');
});

// Invariant: two viewers of one browser both receive its frames.
test('two viewers both receive frames', async () => {
  await boot();
  const a = await stack.viewer();
  const b = await stack.viewer();
  await view(a);
  await view(b);
  await a.waitFor((x) => x.frames.length >= 1, 'frame for a');
  await b.waitFor((x) => x.frames.length >= 1, 'frame for b');
});

// Invariant: without control no input, navigation, tab change or dialog answer reaches the browser; all are refused.
test('actions without control are refused with NOT_CONTROLLER and record nothing', async () => {
  await boot();
  const v = await stack.viewer();
  await view(v);
  const tab = v.last('state').activeTabId;
  for (const msg of [click, { msg: 'nav', action: 'goto', url: 'https://x.test' }, { msg: 'tab', action: 'new' }, { msg: 'tab', action: 'close', tabId: tab }, { msg: 'dialog', tabId: tab, action: 'accept' }]) {
    const before = v.of('error').length;
    v.send(msg);
    await v.waitFor((x) => x.of('error').length === before + 1, `error for ${msg.msg}`);
    assert.equal(v.last('error').code, 'NOT_CONTROLLER', msg.msg);
  }
  assert.deepEqual((await stack.recorded()).filter((r) => r.method.startsWith('Input.')), []);
  assert.equal(stack.manager.session('a').snapshot().tabs.length, 1);
});

// Invariant: with control, input reaches the active tab as the matching CDP call.
test('with control, input is dispatched', async () => {
  await boot();
  const v = await stack.viewer();
  await view(v);
  v.send({ msg: 'control', action: 'take' });
  await v.waitFor((x) => x.last('state').controller.you === true, 'control taken');
  v.send(click);
  v.send({ msg: 'input', kind: 'text', text: 'hello' });
  await waitFor(async () => (await stack.recorded()).length === 2, { what: 'recorded input' });
  const rec = await stack.recorded();
  assert.deepEqual(rec.map((r) => r.method), ['Input.dispatchMouseEvent', 'Input.insertText']);
  assert.equal(rec[1].params.text, 'hello');
});

// Invariant: viewers see control as agent / you / someone else; release is holder-only; another viewer can take over.
test('controller states per viewer, steal and holder-only release', async () => {
  await boot();
  const a = await stack.viewer();
  const b = await stack.viewer();
  await view(a);
  await view(b);
  a.send({ msg: 'control', action: 'take' });
  await a.waitFor((x) => x.last('state').controller.you === true, 'a holds');
  await b.waitFor((x) => x.last('state').controller.kind === 'human', 'b sees human');
  assert.equal(b.last('state').controller.you, false);
  assert.equal(stack.manager.summary('a').controller, 'human');
  b.send({ msg: 'control', action: 'release' });
  await b.waitFor((x) => x.last('error')?.code === 'NOT_CONTROLLER', 'release refused');
  b.send({ msg: 'control', action: 'take' });
  await b.waitFor((x) => x.last('state').controller.you === true, 'b stole');
  await a.waitFor((x) => x.last('state').controller.you === false, 'a lost');
  b.send({ msg: 'control', action: 'release' });
  await a.waitFor((x) => x.last('state').controller.kind === 'agent', 'agent again');
  assert.equal(stack.manager.summary('a').controller, 'agent');
});

// Invariant: switching the viewed tab needs no control, and the shared active tab changes for everyone.
test('tab activate works without control; new/close need it', async () => {
  const { session, agent } = await boot();
  const first = session.snapshot().activeTabId;
  const { targetId } = await agent.send('Target.createTarget', { url: 'about:blank' });
  const v = await stack.viewer();
  await waitFor(() => session.snapshot().activeTabId === targetId, { what: 'second active' });
  await view(v);
  v.send({ msg: 'tab', action: 'activate', tabId: first });
  await v.waitFor((x) => x.last('state').activeTabId === first, 'first active');
  v.send({ msg: 'control', action: 'take' });
  await v.waitFor((x) => x.last('state').controller.you, 'control');
  v.send({ msg: 'tab', action: 'new' });
  await v.waitFor((x) => x.last('state').tabs.length === 3, 'new tab');
});

// Invariant: a dialog is shown to viewers (also late ones), answerable only with control, and closes everywhere.
test('dialog round trip with late-joiner replay', async () => {
  const { session, agent } = await boot();
  const tab = session.snapshot().activeTabId;
  const a = await stack.viewer();
  await view(a);
  await agent.send('Fake.openDialog', { targetId: tab, type: 'alert', message: 'hi' });
  await a.waitFor((x) => x.last('dialog'), 'dialog');
  assert.equal(a.last('dialog').message, 'hi');
  assert.equal(a.last('dialog').dialogType, 'alert');
  assert.equal(a.last('dialog').tabId, tab);
  const late = await stack.viewer();
  await view(late);
  await late.waitFor((x) => x.last('dialog'), 'replayed dialog');
  late.send({ msg: 'dialog', tabId: tab, action: 'accept' });
  await late.waitFor((x) => x.last('error')?.code === 'NOT_CONTROLLER', 'refused without control');
  late.send({ msg: 'control', action: 'take' });
  await late.waitFor((x) => x.last('state').controller.you, 'control');
  late.send({ msg: 'dialog', tabId: tab, action: 'accept' });
  await a.waitFor((x) => x.last('dialogClosed'), 'closed for a');
  await late.waitFor((x) => x.last('dialogClosed'), 'closed for late');
});

// Invariant: malformed traffic gets an error reply and never kills the socket or the backend.
test('bad messages are answered with errors', async () => {
  await boot();
  const early = await stack.viewer({ hello: false });
  early.send({ msg: 'view', name: 'a' });
  await early.waitFor((x) => x.last('error'), 'error before hello');
  assert.match(early.last('error').message, /hello/);
  early.ws.send('not json');
  early.ws.send(Buffer.from([1, 2, 3]));
  early.send({ msg: 'bogus' });
  early.send({ msg: 'hello', viewerId: 'short' });
  await early.waitFor((x) => x.of('error').length === 5, 'five errors');
  assert.deepEqual(early.of('error').map((e) => e.code), ['BAD_REQUEST', 'BAD_REQUEST', 'BAD_REQUEST', 'BAD_REQUEST', 'BAD_REQUEST']);
  early.send({ msg: 'hello', viewerId: 'longenough-1' });
  early.send({ msg: 'view', name: '../etc' });
  await early.waitFor((x) => x.of('error').length === 6, 'invalid name');
  assert.equal(early.last('error').code, 'INVALID_NAME');
  early.send({ msg: 'view', name: 'ghost' });
  await early.waitFor((x) => x.of('error').length === 7, 'not running');
  assert.equal(early.last('error').code, 'NOT_RUNNING');
});

// Invariant: frames larger than the limit close the socket (WS_MAX_PAYLOAD), so a client cannot make the backend buffer megabytes.
test('an oversized message closes the connection', async () => {
  await boot();
  const v = await stack.viewer();
  const closed = new Promise((r) => v.ws.once('close', (code) => r(code)));
  v.ws.send('x'.repeat(70 * 1024));
  assert.equal(await closed, 1009);
});

// Invariant: control reverts to the agent when the holder stays away past the lease, and survives a quick reconnect.
test('lease: control reverts after the holder disconnects', async () => {
  await boot({ leaseMs: 120 });
  const holder = await stack.viewer({ viewerId: 'holder-1234' });
  await view(holder);
  holder.send({ msg: 'control', action: 'take' });
  await holder.waitFor((x) => x.last('state').controller.you, 'control');
  holder.ws.terminate();
  await waitFor(() => stack.manager.summary('a').controller === 'agent', { what: 'lease expiry', timeout: 3000 });

  const again = await stack.viewer({ viewerId: 'holder-5678' });
  await view(again);
  again.send({ msg: 'control', action: 'take' });
  await again.waitFor((x) => x.last('state').controller.you, 'control');
  again.ws.terminate();
  const back = await stack.viewer({ viewerId: 'holder-5678' });
  await sleep(250);
  await view(back);
  assert.equal(back.last('state').controller.you, true, 'reconnecting within the lease keeps control');
});

// Invariant: when a browser stops its viewers are told, rather than left watching a frozen frame.
test('stopping a browser tells its viewers', async () => {
  await boot();
  const v = await stack.viewer();
  await view(v);
  await stack.manager.stop('a');
  await v.waitFor((x) => x.last('state').status === 'stopped', 'stopped state');
  await v.waitFor((x) => x.last('browsers').list[0].status === 'stopped', 'browsers list updated');
});

// Invariant: an upgrade request whose target cannot be parsed as a URL is refused with 400 (before and regardless
// of any Origin) and never takes the process down; the backend keeps answering afterwards.
test('malformed upgrade targets are refused with 400 and do not crash the backend', async () => {
  await boot();
  const targets = ['//[', 'http://[', '//[/api/ws', 'http://[::1'];
  const origins = [undefined, 'http://evil.test', `http://127.0.0.1:${stack.port}`];
  for (const target of targets) {
    for (const origin of origins) {
      const head = `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${stack.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${origin ? `Origin: ${origin}\r\n` : ''}\r\n`;
      const answer = await rawExchange(stack.port, head);
      assert.match(answer, /^HTTP\/1\.1 400 /, `${target} origin=${origin}: ${JSON.stringify(answer.slice(0, 60))}`);
      const res = await fetch(`http://127.0.0.1:${stack.port}/api/health`);
      assert.equal(res.status, 200, `backend died after ${target}`);
    }
  }
});

// Invariant: a well-formed upgrade request that fails the handshake (here: no websocket key) cannot crash it either.
test('an incomplete websocket handshake does not crash the backend', async () => {
  await boot();
  const origin = `http://127.0.0.1:${stack.port}`;
  await rawExchange(stack.port, `GET /api/ws HTTP/1.1\r\nHost: 127.0.0.1:${stack.port}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
});
