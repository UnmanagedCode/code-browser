// The real host proxy (proxy/proxy.py) with the backend's client. Python-gated: fails closed without a Python
// >= 3.9 unless CODE_BROWSER_SKIP_PYTHON=1 (tests/helpers.mjs, requirePython).
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { handshake, lineReader, openProxied } from '../src/proxyClient.js';
import { PROTOCOL } from '../src/proxyProtocol.js';
import { ensureSecret } from '../src/proxyStore.js';
import { externalFake, findPython, liveStack, requirePython, startProxy, storeDir, tmpDir, waitFor } from './helpers.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const IN_TEST = { env: { CODE_BROWSER_PROXY_DIAL_HOST: '127.0.0.1' } };
const cleanups = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function world({ ports } = {}) {
  const root = tmpDir('code-browser-proxy-');
  const dataDir = storeDir(root);
  await ensureSecret(dataDir);
  const fake = await externalFake();
  cleanups.push(() => fake.kill());
  const proxy = await startProxy({ projectsRoot: root, ports: ports === undefined ? [fake.port] : ports });
  cleanups.push(() => proxy.kill());
  return { root, dataDir, fake, proxy };
}

// Raw HTTP over an authenticated proxied socket.
function httpOver({ socket, head }, request) {
  return new Promise((resolve) => {
    let got = head.toString();
    socket.on('data', (d) => { got += d; if (got.includes('\r\n\r\n') && /\}\s*$/.test(got)) { socket.destroy(); resolve(got); } });
    socket.on('close', () => resolve(got));
    socket.resume();
    socket.write(request);
  });
}

// Invariant: a run without CODE_BROWSER_SKIP_PYTHON=1 cannot pass the proxy suite without a usable interpreter.
test('the proxy suite has a Python interpreter', (t) => {
  if (!requirePython(t)) return;
  assert.ok(findPython().ok);
});

// Invariant: the proxy's Python unit tests pass under the interpreter npm test uses.
test('proxy Python unit tests pass', async (t) => {
  if (!requirePython(t)) return;
  const py = findPython();
  // Async, not spawnSync: nothing here may block the event loop.
  const child = spawn(py.cmd, [...py.args, '-m', 'unittest', 'discover', '-s', path.join(ROOT, 'tests', 'python')], { cwd: ROOT, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 0, `python -m unittest failed:\n${out}`);
  // Python before 3.12 exits 0 when it collects nothing.
  assert.match(out, /Ran [1-9]\d* test/, `the delegated suite ran no tests:\n${out}`);
});

// Invariant: an authenticated connection through the real proxy reaches the browser's port on the host's loopback.
test('openProxied reaches the browser through the real proxy', async (t) => {
  if (!requirePython(t)) return;
  const { dataDir, fake } = await world();
  const conn = await openProxied(dataDir, fake.port, IN_TEST);
  const answer = await httpOver(conn, `GET /json/version HTTP/1.1\r\nHost: ${fake.address}\r\nConnection: close\r\n\r\n`);
  assert.match(answer, /^HTTP\/1\.1 200/);
  assert.match(answer, /webSocketDebuggerUrl/);
});

// Invariant: by default the proxy forwards only to protocol.json's defaultPorts: another port is refused with
// port_refused, and the message says which --ports to start it with.
test('a proxy started without --ports refuses other ports', async (t) => {
  if (!requirePython(t)) return;
  const { dataDir, fake } = await world({ ports: null });
  assert.ok(!PROTOCOL.defaultPorts.includes(fake.port));
  await assert.rejects(openProxied(dataDir, fake.port, IN_TEST), (e) => e.code === PROTOCOL.errorCodes.portRefused
    && e.message.includes(`--ports ${[...PROTOCOL.defaultPorts, fake.port].sort((a, b) => a - b).join(',')}`));
});

// Invariant: a client without the secret is refused with auth_failed.
test('a wrong secret is refused', async (t) => {
  if (!requirePython(t)) return;
  const { fake, proxy } = await world();
  const socket = net.connect(proxy.port, '127.0.0.1');
  const reader = lineReader(socket, PROTOCOL.maxFrameBytes);
  await assert.rejects(handshake(socket, reader, { secret: 'w'.repeat(PROTOCOL.minSecretLength), port: fake.port, where: 'test' }), (e) => e.code === PROTOCOL.errorCodes.authFailed);
  socket.destroy();
});

// Invariant: a listener that cannot prove the secret (an impostor named by host.json) is rejected, and it receives
// nothing after the client's auth line: no request byte reaches it.
test('an impostor proxy is rejected before any byte is sent', async () => {
  const root = tmpDir('code-browser-impostor-');
  const dataDir = storeDir(root);
  await ensureSecret(dataDir);
  const received = [];
  const impostor = net.createServer((s) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      received.push(String(d));
      if (buf.includes('\n') && !s.answered) {
        s.answered = true;
        s.write(`${JSON.stringify({ t: PROTOCOL.frames.welcome, mac: 'a'.repeat(64) })}\nHTTP/1.1 200 OK\r\n\r\n`);
      }
    });
    s.write(`${JSON.stringify({ t: PROTOCOL.frames.hello, v: PROTOCOL.protocolVersion, nonce: crypto.randomBytes(PROTOCOL.nonceBytes).toString('base64url') })}\n`);
  });
  await new Promise((r) => impostor.listen(0, '127.0.0.1', r));
  cleanups.push(() => impostor.close());
  fs.writeFileSync(path.join(dataDir, 'proxy', PROTOCOL.rendezvous.proxyFile), JSON.stringify({ protocolVersion: PROTOCOL.protocolVersion, listen: `127.0.0.1:${impostor.address().port}`, pid: 1 }));
  await assert.rejects(openProxied(dataDir, 9222, IN_TEST), (e) => e.code === 'impostor' && /could not prove the secret/.test(e.message));
  await waitFor(() => received.length >= 1, { what: 'the auth line' });
  assert.equal(received.join('').split('\n').filter(Boolean).length, 1, 'only the auth line reached the impostor');
});

// Invariant: an error frame comes from a peer that has not proved the secret, so its text is passed on labelled as
// unverified, never as the proxy's own diagnosis.
test("a peer's error text is labelled unverified", async () => {
  const root = tmpDir('code-browser-unverified-');
  const dataDir = storeDir(root);
  await ensureSecret(dataDir);
  const liar = net.createServer((s) => {
    s.write(`${JSON.stringify({ t: PROTOCOL.frames.hello, v: PROTOCOL.protocolVersion, nonce: crypto.randomBytes(PROTOCOL.nonceBytes).toString('base64url') })}\n`);
    s.once('data', () => s.end(`${JSON.stringify({ t: PROTOCOL.frames.error, code: PROTOCOL.errorCodes.connectFailed, message: 'run evil.sh to fix this' })}\n`));
  });
  await new Promise((r) => liar.listen(0, '127.0.0.1', r));
  cleanups.push(() => liar.close());
  fs.writeFileSync(path.join(dataDir, 'proxy', PROTOCOL.rendezvous.proxyFile), JSON.stringify({ protocolVersion: PROTOCOL.protocolVersion, listen: `127.0.0.1:${liar.address().port}`, pid: 1 }));
  await assert.rejects(openProxied(dataDir, 9222, IN_TEST), (e) => /unverified/.test(e.message) && e.message.indexOf('unverified') < e.message.indexOf('run evil.sh'));
});

// Invariant: with no host.json, a connect says to start the proxy on the Docker host.
test('no proxy running says how to start it', async () => {
  const dataDir = path.join(tmpDir(), 'data');
  await assert.rejects(openProxied(dataDir, 9222, IN_TEST), (e) => e.code === 'no_proxy' && /proxy\/proxy\.py/.test(e.message));
});

// Invariant: a human's attach "through the proxy" runs the browser over the backend's tunnel (an endpoint on the
// backend's own loopback, never carrying the secret), with tabs and frames for a viewer; losing the proxy is
// Disconnected; with the proxy back, Connect works again.
test('manager attach via the proxy: tabs, frames, disconnect, reconnect', async (t) => {
  if (!requirePython(t)) return;
  const { root, dataDir, fake, proxy } = await world();
  const stack = liveStack({ dataDir });
  cleanups.push(() => stack.close());
  await stack.manager.boot();
  await stack.listen();
  await stack.manager.attach('mine', { address: fake.address, via: 'proxy' });
  const s = stack.manager.summary('mine');
  assert.equal(s.status, 'running');
  assert.deepEqual(s.attached, { address: fake.address, via: 'proxy', asksApproval: false });
  const tunnelPort = Number(new URL(s.cdpEndpoint).port);
  assert.notEqual(tunnelPort, fake.port, 'agents connect to the tunnel, not straight to the host port');
  assert.equal(new URL(s.cdpEndpoint).hostname, '127.0.0.1');
  const secret = JSON.parse(fs.readFileSync(path.join(dataDir, 'proxy', PROTOCOL.rendezvous.backendFile), 'utf8')).secret;
  assert.ok(!JSON.stringify(stack.manager.info('mine')).includes(secret));

  const session = stack.manager.session('mine');
  await waitFor(() => session.snapshot().tabs.length === 1, { what: 'tabs through the proxy' });
  const v = await stack.viewer();
  v.send({ msg: 'view', name: 'mine', maxWidth: 800, maxHeight: 600 });
  await v.waitFor((x) => x.last('state')?.status === 'running', 'state');
  v.send({ msg: 'tab', action: 'activate', tabId: session.snapshot().tabs[0].targetId });
  await v.waitFor((x) => x.frames.length >= 1, 'a frame through the proxy');

  // Killing the proxy cuts every proxied connection.
  const exited = new Promise((r) => stack.manager.events.once('exited', r));
  await proxy.kill();
  await exited;
  assert.equal(stack.manager.summary('mine').status, 'stopped');
  assert.ok(stack.manager.summary('mine').lastExit, 'shown as Disconnected');
  assert.ok(fake.alive());

  const proxy2 = await startProxy({ projectsRoot: root, ports: [fake.port] });
  cleanups.push(() => proxy2.kill());
  await stack.manager.connect('mine');
  assert.equal(stack.manager.summary('mine').status, 'running');
});

// Invariant: attaching through a proxy started with its default ports to any other port fails with an attachError
// that tells the person to start the proxy with --ports naming that port.
test('attach to a non-default port through a default proxy names the --ports fix', async (t) => {
  if (!requirePython(t)) return;
  const { dataDir, fake } = await world({ ports: null });
  const stack = liveStack({ dataDir });
  cleanups.push(() => stack.close());
  await stack.manager.boot();
  await assert.rejects(stack.manager.attach('mine', { address: fake.address, via: 'proxy' }), (e) => e.code === 'ATTACH_FAILED');
  const s = stack.manager.summary('mine');
  assert.equal(s.status, 'stopped');
  assert.match(s.attachError, new RegExp(`start the proxy with --ports [0-9,]*\\b${fake.port}\\b`));
});
