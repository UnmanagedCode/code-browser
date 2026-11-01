import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { discover } from '../src/cdpDiscovery.js';
import { MAX_DISCOVERY_BYTES } from '../src/limits.js';
import { externalFake, listen } from './helpers.mjs';

const fakes = [];
after(async () => { for (const f of fakes) await f.kill(); });

// Invariant: a JSON /json/version yields the browser socket on the address asked through, with its id.
test('discover: JSON mode names the browser socket and id', async () => {
  const fake = await externalFake();
  fakes.push(fake);
  const found = await discover(fake.address, { timeoutMs: 2000 });
  assert.deepEqual(found, { wsUrl: `ws://${fake.address}${fake.wsPath}`, browserId: fake.wsPath.split('/').pop(), asksApproval: false });
});

// Invariant: an empty 404 is Chrome's approval mode: the browser socket without an id, and asksApproval.
test('discover: an empty 404 is approval mode', async () => {
  const fake = await externalFake({ approval: true });
  fakes.push(fake);
  assert.deepEqual(await discover(fake.address, { timeoutMs: 2000 }), { wsUrl: `ws://${fake.address}/devtools/browser`, browserId: null, asksApproval: true });
});

async function stub(handler) {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push(req.headers); handler(req, res); });
  const port = await listen(server);
  return { base: `127.0.0.1:${port}`, seen, close: () => server.close() };
}

// Invariant: anything but those two answers (a non-empty 404, a redirect, a socket on another host, an oversized
// answer, nothing listening) is ATTACH_FAILED, and discovery never sends an Origin.
test('discover refuses other answers and sends no Origin', async () => {
  const cases = [
    (req, res) => { res.statusCode = 404; res.end('Not Found'); },
    (req, res) => { res.statusCode = 302; res.setHeader('location', 'http://evil.test/json/version'); res.end(); },
    (req, res) => res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://evil.test:1/devtools/browser/abc' })),
    (req, res) => res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://${req.headers.host}/devtools/page/abc` })),
    (req, res) => res.end('x'.repeat(MAX_DISCOVERY_BYTES + 10)),
    (req, res) => res.end('not json'),
  ];
  for (const handler of cases) {
    const s = await stub(handler);
    await assert.rejects(discover(s.base, { timeoutMs: 2000 }), (e) => e.code === 'ATTACH_FAILED', handler.toString());
    assert.equal(s.seen[0].origin, undefined);
    s.close();
  }
  const gone = await stub(() => {});
  gone.close();
  await assert.rejects(discover(gone.base, { timeoutMs: 2000 }), (e) => e.code === 'ATTACH_FAILED' && /remote debugging/.test(e.message));
});

// A server that answers slowly forever: either never finishing its headers, or finishing them and trickling the body.
async function trickle(stage) {
  const server = http.createServer();
  const sockets = new Set();
  server.on('connection', (c) => { sockets.add(c); c.on('close', () => sockets.delete(c)); });
  server.on('request', (req, res) => {
    if (stage === 'body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); } else res.socket.write('HTTP/1.1 200 OK\r\nX-Drip: ');
    const timer = setInterval(() => (stage === 'body' ? res.write(' ') : res.socket.write('x')), 50);
    res.socket.on('close', () => clearInterval(timer));
  });
  const port = await listen(server);
  return { base: `127.0.0.1:${port}`, open: () => sockets.size, close: () => { server.close(); for (const c of sockets) c.destroy(); } };
}

// Invariant: discovery has a bounded total deadline: a server trickling bytes (in its headers or its body) cannot keep
// it alive past timeoutMs, and the socket is closed.
for (const stage of ['headers', 'body']) {
  test(`discover gives up on a trickling server at its deadline (${stage})`, async () => {
    const t = await trickle(stage);
    const t0 = Date.now();
    await assert.rejects(discover(t.base, { timeoutMs: 300 }), (e) => e.code === 'ATTACH_FAILED' && /did not answer within 300 ms/.test(e.message));
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(t.open(), 0);
    t.close();
  });
}

// Invariant: an aborted discovery rejects with the abort's reason at once, before or during the request.
test('discover observes its abort signal', async () => {
  const t = await trickle('headers');
  const reason = new Error('cancelled');
  const ac = new AbortController();
  const pending = discover(t.base, { timeoutMs: 10_000, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 100));
  ac.abort(reason);
  await assert.rejects(pending, (e) => e === reason);
  await assert.rejects(discover(t.base, { timeoutMs: 10_000, signal: ac.signal }), (e) => e === reason);
  t.close();
});
