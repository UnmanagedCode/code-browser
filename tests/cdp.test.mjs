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
