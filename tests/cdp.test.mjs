import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { CdpConnection } from '../src/cdp.js';

const cleanup = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

async function connect(onMessage) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const sockets = [];
  wss.on('connection', (ws) => { sockets.push(ws); ws.on('message', (d) => onMessage(ws, JSON.parse(d.toString()))); });
  const conn = await CdpConnection.connect(`ws://127.0.0.1:${wss.address().port}`);
  cleanup.push(() => { conn.close(); wss.close(); for (const s of sockets) s.terminate(); });
  return { conn, sockets };
}

// Invariant: a response is matched to its request by id and carries the session id the caller named.
test('send resolves with the result and forwards sessionId and params', async () => {
  const seen = [];
  const { conn } = await connect((ws, m) => { seen.push(m); ws.send(JSON.stringify({ id: m.id, result: { ok: m.params.x } })); });
  assert.deepEqual(await conn.send('Foo.bar', { x: 5 }, { sessionId: 's1' }), { ok: 5 });
  assert.equal(seen[0].sessionId, 's1');
  assert.equal(seen[0].method, 'Foo.bar');
});

// Invariant: a CDP error response rejects with the method named; it never resolves silently.
test('an error response rejects with CDP_ERROR', async () => {
  const { conn } = await connect((ws, m) => ws.send(JSON.stringify({ id: m.id, error: { message: 'nope' } })));
  await assert.rejects(conn.send('Foo.bar'), (e) => e.code === 'CDP_ERROR' && e.message.includes('Foo.bar') && e.message.includes('nope'));
});

// Invariant: every call is bounded; a silent peer cannot hang the caller.
test('an unanswered call rejects with CDP_TIMEOUT', async () => {
  const { conn } = await connect(() => {});
  await assert.rejects(conn.send('Foo.bar', {}, { timeoutMs: 30 }), (e) => e.code === 'CDP_TIMEOUT');
});

// Invariant: events are surfaced with method, params and session; the connection closing rejects pending calls.
test('events are emitted; close rejects pending and later calls', async () => {
  const { conn, sockets } = await connect(() => {});
  const events = [];
  conn.on('event', (e) => events.push(e));
  const closed = new Promise((r) => conn.once('close', r));
  sockets[0].send(JSON.stringify({ method: 'Page.loadEventFired', params: { t: 1 }, sessionId: 's' }));
  const pending = conn.send('Foo.bar');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(events, [{ method: 'Page.loadEventFired', params: { t: 1 }, sessionId: 's' }]);
  sockets[0].terminate();
  await assert.rejects(pending, (e) => e.code === 'CDP_CLOSED');
  await closed;
  await assert.rejects(conn.send('Foo.bar'), (e) => e.code === 'CDP_CLOSED');
});

// ---- forward: commands relayed for a CDP relay client ----

// Invariant: forward hands back the browser's raw answer, result or error with its code and data, never a thrown error.
test('forward delivers the raw result or error', async () => {
  const { conn } = await connect((ws, m) => ws.send(JSON.stringify(m.method === 'Bad.x'
    ? { id: m.id, error: { code: -32601, message: 'nope', data: 'd' } }
    : { id: m.id, result: { got: m.params.x, sessionId: m.sessionId } })));
  const answers = [];
  await new Promise((r) => conn.forward('Ok.x', { x: 1 }, { sessionId: 's' }, (a) => { answers.push(a); r(); }));
  await new Promise((r) => conn.forward('Bad.x', {}, {}, (a) => { answers.push(a); r(); }));
  assert.deepEqual(answers, [{ result: { got: 1, sessionId: 's' } }, { error: { code: -32601, message: 'nope', data: 'd' } }]);
});

// Invariant: an answer and the events the browser sent after it reach listeners in that order, even within one read.
test('forward keeps answers and later events in arrival order', async () => {
  const { conn } = await connect((ws, m) => {
    ws.send(JSON.stringify({ id: m.id, result: {} }));
    ws.send(JSON.stringify({ method: 'Runtime.executionContextCreated', params: {}, sessionId: 's' }));
  });
  const order = [];
  conn.on('event', (e) => order.push(e.method));
  await new Promise((r) => {
    conn.forward('Page.enable', {}, { sessionId: 's' }, () => order.push('answer'));
    conn.once('event', () => setImmediate(r));
  });
  assert.deepEqual(order, ['answer', 'Runtime.executionContextCreated']);
});

// Invariant: an aborted forward leaves nothing pending and its late answer is never delivered; an already-aborted
// signal sends nothing.
test('forward: abort drops the pending entry and the late answer', async () => {
  const seen = [];
  let answerLate;
  const { conn } = await connect((ws, m) => { seen.push(m.method); answerLate = () => ws.send(JSON.stringify({ id: m.id, result: {} })); });
  const abort = new AbortController();
  let delivered = false;
  conn.forward('Slow.x', {}, { signal: abort.signal }, () => { delivered = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(conn.pendingCount, 1);
  abort.abort(new Error('client left'));
  assert.equal(conn.pendingCount, 0);
  answerLate();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(delivered, false);
  conn.forward('Never.x', {}, { signal: abort.signal }, () => { delivered = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, ['Slow.x']);
  assert.equal(delivered, false);
});

// Invariant: when the connection closes, a pending forward is dropped unanswered (only the browser answers a forward),
// so is a later one; the caller learns of the close from 'close'. A pending send still rejects with CDP_CLOSED.
test('forward: close drops pending and later forwards unanswered; send still rejects', async () => {
  const { conn, sockets } = await connect(() => {});
  const answers = [];
  conn.forward('Foo.bar', {}, {}, (a) => answers.push(a));
  const sent = conn.send('Foo.baz');
  await new Promise((r) => setTimeout(r, 20));
  const closed = new Promise((r) => conn.once('close', r));
  sockets[0].terminate();
  await closed;
  await assert.rejects(sent, (e) => e.code === 'CDP_CLOSED');
  conn.forward('Foo.bar', {}, {}, (a) => answers.push(a));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(answers, []);
  assert.equal(conn.pendingCount, 0);
});
