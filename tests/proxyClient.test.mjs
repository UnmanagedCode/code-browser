import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createLimiter, dialCandidates, lineReader, mac, openProxied, parseDefaultGateway, verifyMac } from '../src/proxyClient.js';
import { PROTOCOL } from '../src/proxyProtocol.js';
import { ensureSecret } from '../src/proxyStore.js';
import { fakeProxy } from './fakes/fakeProxy.mjs';
import { tmpDir, within } from './helpers.mjs';

const VECTOR = JSON.parse(fs.readFileSync(new URL('./fixtures/proxy-mac-vector.json', import.meta.url), 'utf8'));

// Invariant: the backend's MAC agrees with the shared fixture vector that the Python proxy's tests also check.
test('mac matches the shared vector for both labels', () => {
  const v = VECTOR;
  assert.equal(mac(v.secret, PROTOCOL.macLabels.client, v.nonceProxy, v.nonceClient, v.port), v.clientMac);
  assert.equal(mac(v.secret, PROTOCOL.macLabels.proxy, v.nonceProxy, v.nonceClient, v.port), v.proxyMac);
  assert.ok(verifyMac(v.proxyMac, v.proxyMac));
  assert.ok(!verifyMac(v.proxyMac, v.clientMac));
  assert.ok(!verifyMac(v.proxyMac, undefined));
});

// Invariant: outside a container the proxy is dialled where it says it listens; inside one, a loopback listener is
// reached through the Docker Desktop name and any other address as written, then via the default gateway.
test('dialCandidates in and out of a container', () => {
  const gateway = '172.17.0.1';
  assert.deepEqual(dialCandidates('127.0.0.1', { inContainer: false, gateway }), ['127.0.0.1']);
  assert.deepEqual(dialCandidates('172.17.0.1', { inContainer: false, gateway }), ['172.17.0.1']);
  assert.deepEqual(dialCandidates('127.0.0.1', { inContainer: true, gateway }), ['host.docker.internal']);
  assert.deepEqual(dialCandidates('127.0.0.1', { inContainer: true, gateway, loopbackHost: '127.0.0.9' }), ['127.0.0.9']);
  assert.deepEqual(dialCandidates('172.18.0.1', { inContainer: true, gateway }), ['172.18.0.1', '172.17.0.1']);
  assert.deepEqual(dialCandidates('172.17.0.1', { inContainer: true, gateway }), ['172.17.0.1']);
  assert.deepEqual(dialCandidates('172.17.0.1', { inContainer: true, gateway: null }), ['172.17.0.1']);
});

// Invariant: the default gateway comes from the first default route in /proc/net/route, read little-endian.
test('parseDefaultGateway', () => {
  const text = 'Iface\tDestination\tGateway\tFlags\n'
    + 'eth0\t000011AC\t00000000\t0001\n'
    + 'eth0\t00000000\t010011AC\t0003\n';
  assert.equal(parseDefaultGateway(text), '172.17.0.1');
  assert.equal(parseDefaultGateway('Iface\tDestination\tGateway\tFlags\neth0\t000011AC\t00000000\t0001\n'), null);
  assert.equal(parseDefaultGateway(''), null);
});

// Invariant: a frame longer than maxFrameBytes from the proxy is a bad_frame, and bytes after a frame are handed
// back untouched by detach().
test('lineReader caps frames and keeps the bytes after the last frame', async () => {
  const server = net.createServer((s) => s.end(`{"t":"a"}\nREST`));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const socket = net.connect(server.address().port, '127.0.0.1');
  const reader = lineReader(socket, 64);
  assert.deepEqual(await reader.next(), { t: 'a' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(reader.detach().toString(), 'REST');
  socket.destroy();

  const big = net.createServer((s) => s.end('x'.repeat(100)));
  await new Promise((r) => big.listen(0, '127.0.0.1', r));
  const s2 = net.connect(big.address().port, '127.0.0.1');
  await assert.rejects(lineReader(s2, 64).next(), (e) => e.code === PROTOCOL.errorCodes.badFrame);
  s2.destroy();
  server.close();
  big.close();
});

// Invariant: a job aborted while it waits in the limiter's queue rejects at once with the abort's reason and never
// runs; the jobs ahead of it are unaffected.
test('an aborted queued job rejects at once and never runs', async () => {
  const limiter = createLimiter(1);
  let release;
  const first = limiter.run(() => new Promise((r) => { release = r; }));
  const ac = new AbortController();
  let ran = false;
  const queued = limiter.run(() => { ran = true; }, ac.signal);
  const reason = new Error('cancelled');
  ac.abort(reason);
  await within(assert.rejects(queued, (e) => e === reason), 500, 'the queued job');
  release('done');
  assert.equal(await first, 'done');
  await new Promise((r) => setImmediate(r));
  assert.equal(ran, false);
  await assert.rejects(limiter.run(() => {}, ac.signal), (e) => e === reason, 'an already-aborted signal is refused before queueing');
});

// Invariant: an aborted proxy dial rejects promptly while it is still queued behind in-flight handshakes.
test('openProxied observes its abort while queued', async () => {
  const dataDir = path.join(tmpDir(), 'data');
  await ensureSecret(dataDir);
  const proxy = await fakeProxy(dataDir);
  const limiter = createLimiter(1);
  let release;
  limiter.run(() => new Promise((r) => { release = r; }));
  const ac = new AbortController();
  const reason = new Error('cancelled');
  const dial = openProxied(dataDir, 9222, { env: { CODE_BROWSER_PROXY_DIAL_HOST: '127.0.0.1' }, limiter, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 50));
  ac.abort(reason);
  try {
    await within(assert.rejects(dial, (e) => e === reason), 500, 'the queued dial');
    assert.equal(proxy.connections(), 0, 'it never dialled');
  } finally { release(); proxy.close(); }
});
