import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { openTunnel } from '../src/tunnel.js';
import { waitFor } from './helpers.mjs';

async function echoServer() {
  const conns = new Set();
  const server = net.createServer((s) => { conns.add(s); s.on('close', () => conns.delete(s)); s.pipe(s); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, conns, port: server.address().port };
}
const upstream = (port) => () => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1', () => resolve({ socket: s, head: Buffer.from('HEAD:') })); });
const exchange = (port, text) => new Promise((resolve) => {
  const c = net.connect(port, '127.0.0.1', () => c.write(text));
  let got = '';
  c.on('data', (d) => { got += d; if (got.length >= text.length + 5) { c.destroy(); resolve(got); } });
  c.on('close', () => resolve(got));
});

// Invariant: each tunnel connection is spliced to one fresh upstream, the upstream's head bytes first.
test('the tunnel splices clients to upstreams, head first', async () => {
  const echo = await echoServer();
  const tunnel = await openTunnel(upstream(echo.port));
  assert.equal(await exchange(tunnel.port, 'hello'), 'HEAD:hello');
  assert.equal(await exchange(tunnel.port, 'again'), 'HEAD:again');
  tunnel.close();
  echo.server.close();
});

// Invariant: a failed upstream drops the client and is kept as lastError for the caller to report.
test('a failed upstream closes the client and records lastError', async () => {
  const tunnel = await openTunnel(() => Promise.reject(Object.assign(new Error('no proxy'), { code: 'no_proxy' })));
  assert.equal(await exchange(tunnel.port, 'x'), '');
  assert.equal(tunnel.lastError.code, 'no_proxy');
  tunnel.close();
});

// Invariant: close() destroys every open connection, both sides, and stops accepting.
test('close destroys every socket', async () => {
  const echo = await echoServer();
  const tunnel = await openTunnel(upstream(echo.port));
  const c = net.connect(tunnel.port, '127.0.0.1');
  c.resume();
  const closed = new Promise((r) => c.on('close', r));
  await waitFor(() => echo.conns.size === 1, { what: 'upstream connection' });
  tunnel.close();
  await closed;
  await waitFor(() => echo.conns.size === 0, { what: 'upstream to close' });
  await assert.rejects(new Promise((resolve, reject) => { const s = net.connect(tunnel.port, '127.0.0.1', resolve); s.on('error', reject); }));
  echo.server.close();
});
