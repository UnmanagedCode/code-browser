import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { helperModuleUrl } from '../src/helperInfo.js';
import { pluginDir } from '../src/config.js';
import codeBrowserModule from '../src/runCode/index.js';
import { createSave } from '../src/runCode/save.js';
import { listen, tmpDir, waitForExit } from './helpers.mjs';

const cleanup = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

// A cc whose every property read throws: any use of it inside the factory would surface.
const hostileCc = new Proxy({}, { get() { throw new Error('the factory touched cc'); } });

// A local server for upgrades and posts that records what reached it; `onUpgrade(req, socket)` answers upgrades.
async function spyServer({ onUpgrade, onRequest } = {}) {
  const seen = { upgrades: [], requests: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { seen.requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) }); onRequest(req, res); });
  });
  server.on('upgrade', (req, socket) => { seen.upgrades.push({ url: req.url, headers: req.headers }); onUpgrade(req, socket); });
  const port = await listen(server);
  cleanup.push(() => server.close());
  return { port, seen };
}

// browser_info's data as the helper reads it, pointing at `port`.
function infoFor(port, { controller = 'agent', kind = 'launched', tokenFile } = {}) {
  return {
    name: 'a', kind, controller, activeTargetId: null,
    helper: { module: helperModuleUrl(pluginDir), relay: `ws://127.0.0.1:${port}/api/relay/a`, artifacts: `http://127.0.0.1:${port}/api/artifacts`, tokenFile, artifactsDir: tmpDir() },
  };
}
const ccWith = (info) => ({ code_browser: { browser_info: async () => info } });
function tokenFile(token = 'ab'.repeat(32)) {
  const f = path.join(tmpDir(), 'token');
  fs.writeFileSync(f, `${token}\n`);
  return f;
}

// Invariant: the factory returns exactly {connect}, and does no I/O: it never touches cc, so a browser that is not
// running cannot make the load itself fail (cc fails the whole namespace for the run when the factory throws).
test('the factory returns {connect} and touches nothing', () => {
  for (const ctx of [{ cc: hostileCc }, { pluginId: 'code-browser', baseUrl: 'http://x', caller: {}, cc: hostileCc }]) {
    const mod = codeBrowserModule(ctx);
    assert.deepEqual(Object.keys(mod), ['connect']);
    assert.equal(typeof mod.connect, 'function');
  }
});

// Invariant: a factory call without a cc object throws a TypeError (cc reports it as a load failure).
test('a missing cc is a TypeError', () => {
  for (const ctx of [undefined, {}, { cc: null }, { cc: 'x' }]) {
    assert.throws(() => codeBrowserModule(ctx), (err) => err instanceof TypeError);
  }
});

// Invariant: cc calls a member with `this` = the factory's object; connect must not depend on it.
test('connect works called as a member of the returned object', async () => {
  const refusal = new Error('x');
  const mod = codeBrowserModule({ cc: { code_browser: { browser_info: async () => { throw refusal; } } } });
  await assert.rejects(mod.connect({}), (err) => err === refusal);
});

// Invariant: while a human holds control, connect refuses with BROWSER_CONTROLLED before reading the token or dialling.
test('connect with a human in control throws BROWSER_CONTROLLED without dialling', async () => {
  const spy = await spyServer({ onUpgrade: (_r, s) => s.destroy() });
  const { connect } = codeBrowserModule({ cc: ccWith(infoFor(spy.port, { controller: 'human', tokenFile: '/nonexistent/token' })) });
  await assert.rejects(connect({ name: 'a' }), (err) => err.code === 'BROWSER_CONTROLLED' && /refused while a human has control/.test(err.message));
  assert.deepEqual(spy.seen.upgrades, []);
});

// Invariant: browser_info's own refusal (a browser that is not running, a bad name) reaches the program unchanged.
test("connect passes browser_info's refusal through", async () => {
  const refusal = Object.assign(new Error('NOT_RUNNING: browser stopped'), { name: 'ConductorError', code: 'NOT_RUNNING' });
  const { connect } = codeBrowserModule({ cc: { code_browser: { browser_info: async () => { throw refusal; } } } });
  await assert.rejects(connect(), (err) => err === refusal);
});

// Invariant: connect dials the relay with the bearer token read from helper.tokenFile, and a refused upgrade becomes an
// error carrying the relay's code (the text/plain body `CODE: message`).
test('a refused relay upgrade becomes an error with its code', async () => {
  const token = 'cd'.repeat(32);
  for (const [status, body, code] of [[409, "BROWSER_CONTROLLED: a person controls 'a' in the panel", 'BROWSER_CONTROLLED'], [401, 'UNAUTHORIZED: bad token', 'UNAUTHORIZED'], [409, "NOT_RUNNING: browser 'a' is not running", 'NOT_RUNNING']]) {
    const spy = await spyServer({ onUpgrade: (_r, s) => s.end(`HTTP/1.1 ${status} X\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`) });
    const { connect } = codeBrowserModule({ cc: ccWith(infoFor(spy.port, { tokenFile: tokenFile(token) })) });
    await assert.rejects(connect({ timeout: 5000 }), (err) => err.code === code && body.endsWith(err.message));
    assert.equal(spy.seen.upgrades[0].headers.authorization, `Bearer ${token}`);
    assert.equal(spy.seen.upgrades[0].url, '/api/relay/a');
  }
});

// Invariant: save POSTs the bytes as application/octet-stream with the bearer token and the extension, and resolves the
// path the backend answers.
test('save posts octet-stream with the token and returns the path', async () => {
  const spy = await spyServer({ onRequest: (_req, res) => { res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"path":"/data/artifacts/1-a.png"}'); } });
  const save = createSave({ url: `http://127.0.0.1:${spy.port}/api/artifacts`, token: 'ef'.repeat(32) });
  assert.equal(await save(Buffer.from([1, 2, 3]), 'png'), '/data/artifacts/1-a.png');
  const [r] = spy.seen.requests;
  assert.equal(r.method, 'POST');
  assert.equal(r.url, '/api/artifacts?ext=png');
  assert.equal(r.headers['content-type'], 'application/octet-stream');
  assert.equal(r.headers.authorization, `Bearer ${'ef'.repeat(32)}`);
  assert.deepEqual(r.body, Buffer.from([1, 2, 3]));
});

// Invariant: a refused save throws the backend's code; bytes that are not a Buffer/Uint8Array are refused locally.
test('save surfaces the backend refusal and checks its input', async () => {
  const spy = await spyServer({ onRequest: (_req, res) => { res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"error":"PAYLOAD_TOO_LARGE: body larger than 9 bytes"}'); } });
  const save = createSave({ url: `http://127.0.0.1:${spy.port}/api/artifacts`, token: 'ef'.repeat(32) });
  await assert.rejects(save(Buffer.from('x'), 'png'), (e) => e.code === 'PAYLOAD_TOO_LARGE' && e.message === 'body larger than 9 bytes');
  await assert.rejects(save('a string', 'txt'), (e) => e.code === 'BAD_REQUEST');
  assert.equal(spy.seen.requests.length, 1);
});

// Invariant: the module loads and its factory runs under cc's plan-mode permissions (--permission --allow-fs-read=*),
// and it resolves code-browser's own playwright-core, never a copy beside the program (a decoy in its cwd throws).
test('the module loads under --permission and uses its own playwright-core', async () => {
  const cwd = tmpDir();
  fs.mkdirSync(path.join(cwd, 'node_modules', 'playwright-core'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'node_modules', 'playwright-core', 'package.json'), '{"name":"playwright-core","type":"module","main":"index.js","exports":"./index.js"}');
  fs.writeFileSync(path.join(cwd, 'node_modules', 'playwright-core', 'index.js'), "throw new Error('DECOY playwright-core loaded');");
  const program = `const mod = await import(${JSON.stringify(helperModuleUrl(pluginDir))});
const m = mod.default({ cc: {} });
console.log(JSON.stringify({ keys: Object.keys(m) }));`;
  const child = spawn(process.execPath, ['--permission', '--allow-fs-read=*', '--input-type=module', '-e', program], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  assert.equal(await waitForExit(child, 20_000, 'the plan-mode import'), 0, out);
  assert.deepEqual(JSON.parse(out.trim()), { keys: ['connect'] });
});
