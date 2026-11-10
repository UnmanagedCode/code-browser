// MCP json replies validated against the manifest schemas with realistic data: the real manager, session and
// attach code over the fake Chromium, on temp data dirs only (never the live store).
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createBrowserManager } from '../src/browserManager.js';
import { createMcp } from '../src/mcp.js';
import { testHelperInfo } from './fakes/fakeMcpManager.mjs';
import { readRun } from '../src/runState.js';
import { call } from './_mcpCall.mjs';
import { FAKE_CHROMIUM, externalFake, liveStack, pidAlive, tmpDir, waitFor } from './helpers.mjs';

let stack;
const cleanups = [];
afterEach(async () => {
  await stack?.close();
  stack = null;
  for (const fn of cleanups.splice(0)) await fn();
});
const mcpOf = (manager) => createMcp({ manager, pluginDir: '/plug', pluginId: 'code-browser', helperInfo: testHelperInfo });
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// Invariant: start_browser and browser_info json validate with the real session's tabs, and a tab opened later by an
// agent's own CDP connection appears in both the json and the text meta.
test('start_browser / browser_info json with real tabs, including a second tab', async () => {
  stack = liveStack();
  await stack.manager.boot();
  const mcp = mcpOf(stack.manager);
  const started = (await call(mcp, 'start_browser', { name: 'a' }, 'json')).structured;
  assert.equal(started.status, 'running');
  assert.equal(started.kind, 'launched');
  await waitFor(() => stack.manager.session('a').snapshot().tabs.length === 1, { what: 'first tab' });
  const agent = await stack.agent('a');
  await agent.send('Target.createTarget', { url: 'about:blank' });
  await waitFor(() => stack.manager.session('a').snapshot().tabs.length === 2, { what: 'second tab' });
  const info = (await call(mcp, 'browser_info', { name: 'a' }, 'json')).structured;
  assert.equal(info.tabs.length, 2);
  assert.equal(info.tabs.filter((t) => t.active).length, 1);
  assert.equal(info.activeTargetId, info.tabs.find((t) => t.active).targetId);
  assert.equal((await call(mcp, 'browser_info', { name: 'a' }, 'text')).meta.tabs.length, 2);
  assert.equal((await call(mcp, 'stop_browser', { name: 'a' }, 'json')).structured.status, 'stopped');
});

// Invariant: after a crash the listing validates and reports lastExit as an object (code, signal, at), in text too.
test('list_browsers json after a crash carries lastExit', async () => {
  stack = liveStack();
  await stack.manager.boot();
  const mcp = mcpOf(stack.manager);
  await call(mcp, 'start_browser', { name: 'a' }, 'json');
  const { chromiumPid } = readRun(stack.dataDir, 'a');
  process.kill(chromiumPid, 'SIGKILL');
  await waitFor(() => stack.manager.summary('a').status === 'stopped' && !pidAlive(chromiumPid), { what: 'the crash to be seen' });
  const [b] = (await call(mcp, 'list_browsers', {}, 'json')).structured.browsers;
  assert.equal(b.status, 'stopped');
  assert.equal(typeof b.lastExit, 'object');
  assert.ok(b.lastExit && Number.isInteger(b.lastExit.at));
  assert.match((await call(mcp, 'list_browsers', {}, 'text')).text, /lastExit code/);
});

// Invariant: a failed attach (closed port) leaves an attachError string that validates, and shows in text.
test('list_browsers json with an attachError', async () => {
  stack = liveStack();
  await stack.manager.boot();
  const mcp = mcpOf(stack.manager);
  await assert.rejects(stack.manager.attach('mine', { address: `127.0.0.1:${await freePort()}`, via: 'direct' }));
  const [b] = (await call(mcp, 'list_browsers', {}, 'json')).structured.browsers;
  assert.equal(b.kind, 'attached');
  assert.equal(typeof b.attachError, 'string');
  assert.match((await call(mcp, 'list_browsers', {}, 'text')).text, /attachError "/);
});

// Invariant: an attached direct browser's browser_info json validates with kind attached.
test('browser_info json for an attached direct browser', async () => {
  stack = liveStack();
  await stack.manager.boot();
  const f = await externalFake();
  cleanups.push(() => f.kill());
  await stack.manager.attach('mine', { address: f.address, via: 'direct' });
  await waitFor(() => stack.manager.session('mine').snapshot().tabs.length >= 1, { what: 'attached tabs' });
  const d = (await call(mcpOf(stack.manager), 'browser_info', { name: 'mine' }, 'json')).structured;
  assert.equal(d.kind, 'attached');
  assert.equal(d.attached.via, 'direct');
  assert.equal(d.sandbox, null);
});

// Invariant: a missing CODE_BROWSER_CHROMIUM override is refused as CHROMIUM_NOT_FOUND with details.path (real locate path).
test('CHROMIUM_NOT_FOUND details.path from the real manager', async () => {
  stack = liveStack({ env: { CODE_BROWSER_CHROMIUM: '/nonexistent/chrome' } });
  await stack.manager.boot();
  const r = await call(mcpOf(stack.manager), 'start_browser', { name: 'a' }, 'json');
  assert.equal(r.code, 'CHROMIUM_NOT_FOUND');
  assert.deepEqual(r.details, { path: '/nonexistent/chrome' });
});

// Invariant: a launch that never exposes its port is LAUNCH_FAILED with details.logTail as a string (real launch path).
test('LAUNCH_FAILED details.logTail from the real manager', async () => {
  const dataDir = tmpDir();
  const t0 = Date.now();
  const started = () => fs.existsSync(path.join(dataDir, 'profiles', 'a', 'fake-pid'));
  const manager = createBrowserManager({
    dataDir,
    env: { ...process.env, CODE_BROWSER_CHROMIUM: FAKE_CHROMIUM, FAKE_CHROMIUM_NO_PORT: '1' },
    log: { warn() {}, error() {} },
    timeouts: { launch: 300, stopGrace: 1500, killGrace: 200, shutdownGrace: 500 },
    now: () => (started() || Date.now() - t0 > 10_000 ? Number.MAX_SAFE_INTEGER : 0),
  });
  cleanups.push(() => manager.shutdown());
  const r = await call(mcpOf(manager), 'start_browser', { name: 'a' }, 'json');
  assert.equal(r.code, 'LAUNCH_FAILED');
  assert.equal(typeof r.details.logTail, 'string');
});

// Invariant: the oldest layout the plugin can still load validates: a bare profile dir, a settings file with unknown keys,
// malformed settings and attached records (read as none), an extra-field attached record with a `localhost` address
// (normalised to 127.0.0.1) and a stale run file. Every schema field is still present and typed.
test('the oldest stored shapes still produce valid list_browsers json', async () => {
  const dataDir = tmpDir();
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true }); fs.writeFileSync(path.join(dataDir, rel), text); };
  fs.mkdirSync(path.join(dataDir, 'profiles', 'old'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'profiles', 'old2'), { recursive: true });
  w('settings/old.json', '{"allowUnsandboxed":true,"legacy":1}');
  w('settings/old2.json', '{not json');
  w('attached/mine.json', '{"address":"localhost:9222","via":"direct","note":"x"}');
  w('attached/bad.json', '{nope');
  w('run/old.json', '{"keeperPid":999999991,"chromiumPid":999999992,"startedAt":1}');
  stack = liveStack({ dataDir });
  await stack.manager.boot();
  const mcp = mcpOf(stack.manager);
  const { browsers } = (await call(mcp, 'list_browsers', {}, 'json')).structured;
  const by = Object.fromEntries(browsers.map((b) => [b.name, b]));
  assert.deepEqual(Object.keys(by).sort(), ['mine', 'old', 'old2']);
  assert.equal(by.mine.attached.address, '127.0.0.1:9222');
  assert.equal(by.old.allowUnsandboxed, true);
  assert.equal(by.old2.allowUnsandboxed, false);
  await call(mcp, 'list_browsers', {}, 'text');
});
