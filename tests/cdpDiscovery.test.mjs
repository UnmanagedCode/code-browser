import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { discover, parseAttachTarget } from '../src/cdpDiscovery.js';
import { MAX_DISCOVERY_BYTES } from '../src/limits.js';
import { externalFake, listen } from './helpers.mjs';

const fakes = [];
after(async () => { for (const f of fakes) await f.kill(); });

// Invariant: only a loopback port is accepted (localhost canonicalised to 127.0.0.1), via proxy or direct; anything
// else is BAD_ENDPOINT, so the backend never dials an arbitrary host.
test('parseAttachTarget accepts loopback ports only', () => {
  assert.deepEqual(parseAttachTarget({ address: '127.0.0.1:9222', via: 'proxy' }), { address: '127.0.0.1:9222', port: 9222, via: 'proxy' });
  assert.deepEqual(parseAttachTarget({ address: ' localhost:1 ', via: 'direct' }), { address: '127.0.0.1:1', port: 1, via: 'direct' });
  for (const body of [
    { address: '10.0.0.1:9222', via: 'proxy' }, { address: 'example.com:9222', via: 'direct' }, { address: '127.0.0.2:9222', via: 'direct' },
    { address: '[::1]:9222', via: 'direct' }, { address: '127.0.0.1:0', via: 'proxy' }, { address: '127.0.0.1:65536', via: 'proxy' },
    { address: '127.0.0.1', via: 'proxy' }, { address: 'http://127.0.0.1:9222', via: 'proxy' }, { address: 9222, via: 'proxy' },
    { address: '127.0.0.1:9222', via: 'lan' }, { address: '127.0.0.1:9222' }, null,
  ]) {
    assert.throws(() => parseAttachTarget(body), (e) => e.code === 'BAD_ENDPOINT', JSON.stringify(body));
  }
});

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
