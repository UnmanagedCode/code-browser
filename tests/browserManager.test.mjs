import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBrowserManager } from '../src/browserManager.js';
import { pidAlive } from '../src/runState.js';
import { tmpDir, waitFor } from './helpers.mjs';

const FAKE = new URL('./fakes/fakeChromium.mjs', import.meta.url).pathname;
const managers = [];

function make({ dataDir = tmpDir(), env = {}, timeouts = {} } = {}) {
  const warns = [];
  const manager = createBrowserManager({
    dataDir,
    env: { ...process.env, CODE_BROWSER_CHROMIUM: FAKE, ...env },
    log: { warn: (m) => warns.push(m) },
    timeouts: { launch: 4000, stopGrace: 1500, killGrace: 200, shutdownGrace: 500, ...timeouts },
  });
  managers.push(manager);
  return { manager, dataDir, warns, profile: (n) => path.join(dataDir, 'profiles', n) };
}
const fakePid = (profile) => Number(fs.readFileSync(path.join(profile, 'fake-pid'), 'utf8'));
afterEach(async () => { await Promise.all(managers.splice(0).map((m) => m.shutdown())); });

// Invariant: create → start → stop → delete move a browser through its lifecycle; stop keeps the profile, delete removes it.
test('lifecycle: create, start (idempotent), stop keeps the profile, delete removes it', async () => {
  const { manager, profile } = make();
  manager.create('a');
  assert.equal(manager.summary('a').status, 'stopped');
  await manager.start('a');
  const first = manager.summary('a');
  assert.equal(first.status, 'running');
  assert.match(first.cdpEndpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  const pid = fakePid(profile('a'));
  await manager.start('a');
  assert.equal(manager.summary('a').cdpEndpoint, first.cdpEndpoint, 'a second start changes nothing');
  assert.equal(fakePid(profile('a')), pid);
  await manager.stop('a');
  assert.equal(manager.summary('a').status, 'stopped');
  assert.equal(manager.summary('a').lastExit, null, 'a requested stop is not a crash');
  await waitFor(() => !pidAlive(pid), { what: 'chromium to exit' });
  assert.ok(fs.existsSync(profile('a')));
  await manager.delete('a');
  assert.ok(!fs.existsSync(profile('a')));
  assert.throws(() => manager.summary('a'), (e) => e.code === 'NOT_FOUND');
});

// Invariant: one name check guards every path into the data dir; traversal and malformed names never reach the filesystem.
test('invalid and traversal names are rejected; duplicates are EXISTS', async () => {
  const { manager, dataDir } = make();
  for (const bad of ['../x', 'A', '', 'a/b', '-a', 'a'.repeat(41), null, undefined, 7]) {
    assert.throws(() => manager.create(bad), (e) => e.code === 'INVALID_NAME', String(bad));
    await assert.rejects(manager.start(bad), (e) => e.code === 'INVALID_NAME');
    await assert.rejects(manager.delete(bad), (e) => e.code === 'INVALID_NAME');
  }
  assert.ok(!fs.existsSync(path.join(dataDir, 'x')));
  manager.create('a');
  assert.throws(() => manager.create('a'), (e) => e.code === 'EXISTS');
  await assert.rejects(manager.start('ghost'), (e) => e.code === 'NOT_FOUND');
});

// Invariant: a new profile is seeded to keep session cookies; an existing profile's Preferences are never rewritten.
test('create seeds restore_on_startup only for new profiles', () => {
  const { manager, profile } = make();
  manager.create('a');
  const prefs = path.join(profile('a'), 'Default', 'Preferences');
  assert.deepEqual(JSON.parse(fs.readFileSync(prefs, 'utf8')), { session: { restore_on_startup: 1 } });
  fs.writeFileSync(prefs, '{"custom":true}');
  manager.ensure('a');
  assert.equal(fs.readFileSync(prefs, 'utf8'), '{"custom":true}');
});

// Invariant: an unexpected exit leaves the browser stopped with lastExit (the panel shows "Crashed") and no auto-restart.
test('a crash gives stopped with lastExit and is not restarted', async () => {
  const { manager, warns } = make();
  manager.create('a');
  await manager.start('a');
  const exited = new Promise((r) => manager.events.once('exited', r));
  await manager.entry('a').cdp.send('Fake.crash').catch(() => {});
  await exited;
  const s = manager.summary('a');
  assert.equal(s.status, 'stopped');
  assert.equal(s.lastExit.signal, 'SIGSEGV');
  assert.equal(s.cdpEndpoint, null);
  assert.ok(warns.some((w) => w.includes('exited unexpectedly')));
});

// Invariant: after a backend restart nothing from the previous backend survives: boot reaps leftovers, profiles stay.
test('boot reaps a browser left by a previous backend and keeps the profile', async () => {
  const dataDir = tmpDir();
  const a = make({ dataDir });
  a.manager.create('a');
  await a.manager.start('a');
  const pid = fakePid(a.profile('a'));
  const b = make({ dataDir });
  await b.manager.boot();
  await waitFor(() => !pidAlive(pid), { what: 'leftover chromium to be reaped' });
  assert.equal(b.manager.summary('a').status, 'stopped');
  assert.ok(fs.existsSync(b.profile('a')));
  assert.equal(fs.existsSync(path.join(dataDir, 'run', 'a.json')), false);
});

// Invariant: cc's restart overlap (new backend starts while the old one still runs) cannot leave two browsers on one profile.
test('starting a profile that a stale backend still runs reaps the old browser first', async () => {
  const dataDir = tmpDir();
  const a = make({ dataDir });
  a.manager.create('a');
  await a.manager.start('a');
  const oldPid = fakePid(a.profile('a'));
  const b = make({ dataDir });
  await b.manager.start('a');
  assert.ok(!pidAlive(oldPid));
  assert.equal(b.manager.summary('a').status, 'running');
  assert.notEqual(fakePid(b.profile('a')), oldPid);
});

// Invariant: a launch that never exposes DevToolsActivePort fails loudly with the log tail and leaves no process.
test('launch timeout gives LAUNCH_FAILED with the log tail and kills the browser', async () => {
  const { manager, profile } = make({ env: { FAKE_CHROMIUM_NO_PORT: '1' }, timeouts: { launch: 300 } });
  manager.create('a');
  await assert.rejects(manager.start('a'), (e) => e.code === 'LAUNCH_FAILED' && /no DevToolsActivePort/.test(e.message));
  const pid = fakePid(profile('a'));
  await waitFor(() => !pidAlive(pid), { what: 'timed-out chromium to be killed' });
  assert.equal(manager.summary('a').status, 'stopped');
});

// Invariant: an unusable sandbox is a logged, visible degradation (sandbox:false), not a silent one, even when the
// message opens a crash dump much longer than the reported log tail (as real Chromium's does).
test('sandbox failure relaunches with --no-sandbox and reports sandbox false', async () => {
  const { manager, warns, profile } = make({ env: { FAKE_CHROMIUM_REQUIRE_NO_SANDBOX: '1' } });
  manager.create('a');
  await manager.start('a');
  assert.equal(manager.summary('a').sandbox, false);
  assert.ok(JSON.parse(fs.readFileSync(path.join(profile('a'), 'fake-argv.json'), 'utf8')).includes('--no-sandbox'));
  assert.ok(warns.some((w) => w.includes('--no-sandbox')));
});

// Invariant: the sandbox stays on whenever Chromium can start with it.
test('a working sandbox is reported as sandbox true', async () => {
  const { manager } = make();
  manager.create('a');
  await manager.start('a');
  assert.equal(manager.summary('a').sandbox, true);
});

// Invariant: a Chromium that ignores Browser.close is still stopped (escalation through the keeper).
test('stop escalates when Browser.close is ignored', async () => {
  const { manager, profile } = make({ env: { FAKE_CHROMIUM_IGNORE_CLOSE: '1' }, timeouts: { stopGrace: 150, killGrace: 100 } });
  manager.create('a');
  await manager.start('a');
  const pid = fakePid(profile('a'));
  await manager.stop('a');
  assert.ok(!pidAlive(pid));
  assert.equal(manager.summary('a').status, 'stopped');
});

// Invariant: a crashed backend's stale Singleton*/DevToolsActivePort files are removed before launch.
test('stale Singleton files are cleared before a start', async () => {
  const { manager, profile } = make();
  manager.create('a');
  fs.symlinkSync('nohost-1234', path.join(profile('a'), 'SingletonLock'));
  fs.writeFileSync(path.join(profile('a'), 'DevToolsActivePort'), '1\n/devtools/browser/stale\n');
  await manager.start('a');
  assert.equal(fs.existsSync(path.join(profile('a'), 'fake-saw-stale-singleton')), false);
  assert.notEqual(manager.entry('a').port, 1);
});

// Invariant: backend shutdown closes every running browser.
test('shutdown stops every running browser', async () => {
  const { manager, profile } = make();
  for (const n of ['a', 'b']) { manager.create(n); await manager.start(n); }
  const pids = ['a', 'b'].map((n) => fakePid(profile(n)));
  await manager.shutdown();
  for (const pid of pids) await waitFor(() => !pidAlive(pid), { what: 'chromium to exit' });
});

const modeOf = (p) => fs.statSync(p).mode & 0o777;

// Invariant: everything under the data dir is private to the host user: directories 0700 (enforced on ones that
// already exist, at boot), run files and logs 0600. The log holds visited URLs and the profile exposes CDP.
test('data tree is 0700 and run files and logs are 0600, including pre-existing ones', async () => {
  const dataDir = path.join(tmpDir(), '.code-browser');
  for (const d of ['', 'profiles', 'profiles/old', 'logs', 'run']) fs.mkdirSync(path.join(dataDir, d), { recursive: true, mode: 0o755 });
  for (const d of ['', 'profiles', 'profiles/old', 'logs', 'run']) fs.chmodSync(path.join(dataDir, d), 0o755);
  fs.writeFileSync(path.join(dataDir, 'logs', 'a.log'), 'old log', { mode: 0o644 });
  fs.chmodSync(path.join(dataDir, 'logs', 'a.log'), 0o644);
  const { manager, profile } = make({ dataDir });
  await manager.boot();
  for (const d of ['', 'profiles', 'profiles/old', 'logs', 'run']) assert.equal(modeOf(path.join(dataDir, d)), 0o700, `boot: ${d || '.code-browser'}`);

  manager.create('a');
  await manager.start('a');
  for (const d of ['', 'profiles', 'logs', 'run', 'trash']) {
    if (fs.existsSync(path.join(dataDir, d))) assert.equal(modeOf(path.join(dataDir, d)), 0o700, d || '.code-browser');
  }
  assert.equal(modeOf(profile('a')), 0o700);
  assert.equal(modeOf(path.join(profile('a'), 'Default')), 0o700);
  assert.equal(modeOf(path.join(dataDir, 'run', 'a.json')), 0o600);
  assert.equal(modeOf(path.join(dataDir, 'logs', 'a.log')), 0o600, 'a pre-existing log is tightened too');
  await manager.delete('a');
  assert.equal(modeOf(path.join(dataDir, 'trash')), 0o700);
});
