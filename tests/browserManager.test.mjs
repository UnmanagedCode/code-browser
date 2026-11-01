import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBrowserManager } from '../src/browserManager.js';
import { pidAlive } from '../src/runState.js';
import { tmpDir, waitFor } from './helpers.mjs';

const FAKE = new URL('./fakes/fakeChromium.mjs', import.meta.url).pathname;
const managers = [];

function make({ dataDir = tmpDir(), env = {}, timeouts = {}, trashFs, now } = {}) {
  const warns = [];
  const manager = createBrowserManager({
    dataDir,
    env: { ...process.env, CODE_BROWSER_CHROMIUM: FAKE, ...env },
    log: { warn: (m) => warns.push(m) },
    timeouts: { launch: 4000, stopGrace: 1500, killGrace: 200, shutdownGrace: 500, ...timeouts },
    ...(trashFs ? { trashFs } : {}),
    ...(now ? { now } : {}),
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
  // The launch clock stands still until the fake has started, then jumps past the deadline: the timeout fires, and
  // always on a browser that did start. A fake that never starts releases the clock after a real bound instead, and
  // the pid check below then fails the test.
  const dataDir = tmpDir();
  const t0 = Date.now();
  const started = () => fs.existsSync(path.join(dataDir, 'profiles', 'a', 'fake-pid'));
  const { manager, profile } = make({ dataDir, env: { FAKE_CHROMIUM_NO_PORT: '1' }, timeouts: { launch: 300 }, now: () => (started() || Date.now() - t0 > 10_000 ? Number.MAX_SAFE_INTEGER : 0) });
  manager.create('a');
  await assert.rejects(manager.start('a'), (e) => e.code === 'LAUNCH_FAILED' && /no DevToolsActivePort/.test(e.message));
  assert.ok(started(), 'the fake started before the deadline fired');
  const pid = fakePid(profile('a'));
  await waitFor(() => !pidAlive(pid), { what: 'timed-out chromium to be killed' });
  assert.equal(manager.summary('a').status, 'stopped');
});

const NO_SANDBOX = { FAKE_CHROMIUM_REQUIRE_NO_SANDBOX: '1' };
const settingsOf = (dataDir, n) => path.join(dataDir, 'settings', `${n}.json`);
const launchedUnsandboxed = (profile) => fs.existsSync(path.join(profile, 'fake-argv.json'));

// Invariant: without a human's opt-in, a host that cannot sandbox never gets an unsandboxed Chromium: the start is
// refused with SANDBOX_UNAVAILABLE, nothing is left running or recorded, and the panel is told (change + summary flag).
test('sandbox failure without the opt-in is refused and launches nothing unsandboxed', async () => {
  const { manager, warns, profile, dataDir } = make({ env: NO_SANDBOX });
  manager.create('a');
  let changes = 0;
  manager.events.on('change', () => { changes++; });
  await assert.rejects(manager.start('a'), (e) => e.code === 'SANDBOX_UNAVAILABLE');
  // The fake writes argv and pid only after its sandbox check passes: their absence proves no --no-sandbox launch.
  assert.equal(launchedUnsandboxed(profile('a')), false);
  assert.equal(fs.existsSync(path.join(profile('a'), 'fake-pid')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'run', 'a.json')), false);
  assert.ok(!warns.some((w) => w.includes('relaunching')));
  assert.deepEqual(manager.summary('a'), { name: 'a', kind: 'launched', status: 'stopped', controller: 'agent', sandbox: null, allowUnsandboxed: false, sandboxUnavailable: true, lastExit: null, cdpEndpoint: null, attached: null, attachError: null });
  assert.ok(changes > 0, 'the refusal emits change');
});

// Invariant: with the opt-in on, the unsandboxed relaunch happens, is logged, and reports sandbox false;
// a successful start clears the refusal flag.
test('sandbox failure with the opt-in relaunches with --no-sandbox and reports sandbox false', async () => {
  const { manager, warns, profile } = make({ env: NO_SANDBOX });
  manager.create('a');
  await assert.rejects(manager.start('a'), (e) => e.code === 'SANDBOX_UNAVAILABLE');
  await manager.setAllowUnsandboxed('a', true);
  assert.equal(manager.summary('a').sandboxUnavailable, true, 'granting alone does not hide the refusal until a start succeeds');
  await manager.start('a');
  const s = manager.summary('a');
  assert.equal(s.sandbox, false);
  assert.equal(s.allowUnsandboxed, true);
  assert.equal(s.sandboxUnavailable, false);
  assert.ok(JSON.parse(fs.readFileSync(path.join(profile('a'), 'fake-argv.json'), 'utf8')).includes('--no-sandbox'));
  assert.ok(warns.some((w) => w.includes('--no-sandbox')));
});

// Invariant: the opt-in is per browser and persisted on disk (a new manager on the same data dir sees it), in a file
// private to the host user; it exists only while on.
test('the opt-in persists across managers, is private, and is per browser', async () => {
  const dataDir = tmpDir();
  const a = make({ dataDir });
  a.manager.create('a');
  a.manager.create('b');
  await a.manager.setAllowUnsandboxed('a', true);
  assert.equal(modeOf(path.join(dataDir, 'settings')), 0o700);
  assert.equal(modeOf(settingsOf(dataDir, 'a')), 0o600);
  const b = make({ dataDir });
  assert.equal(b.manager.summary('a').allowUnsandboxed, true);
  assert.equal(b.manager.summary('b').allowUnsandboxed, false);
  await b.manager.setAllowUnsandboxed('a', false);
  assert.equal(fs.existsSync(settingsOf(dataDir, 'a')), false);
});

// Invariant: an unreadable or malformed settings file counts as "not allowed" (refusing is the safe direction), loudly.
test('a malformed settings file is treated as not allowed and warned about', async () => {
  const { manager, dataDir, warns } = make({ env: NO_SANDBOX });
  manager.create('a');
  fs.mkdirSync(path.join(dataDir, 'settings'), { recursive: true });
  fs.writeFileSync(settingsOf(dataDir, 'a'), '{nope');
  assert.equal(manager.summary('a').allowUnsandboxed, false);
  assert.ok(warns.some((w) => /malformed/.test(w)));
  await assert.rejects(manager.start('a'), (e) => e.code === 'SANDBOX_UNAVAILABLE');
});

// Invariant: revoking consent takes effect now: a browser running unsandboxed is stopped (profile kept, not a crash),
// and the next start is refused. One running sandboxed is left alone.
test('revoking stops an unsandboxed browser at once; a sandboxed one keeps running', async () => {
  const { manager, dataDir, profile } = make({ env: NO_SANDBOX });
  manager.create('a');
  await manager.setAllowUnsandboxed('a', true);
  await manager.start('a');
  const pid = fakePid(profile('a'));
  await manager.setAllowUnsandboxed('a', false);
  const s = manager.summary('a');
  assert.equal(s.status, 'stopped');
  assert.equal(s.lastExit, null, 'a deliberate stop is not a crash');
  assert.equal(s.allowUnsandboxed, false);
  assert.equal(fs.existsSync(settingsOf(dataDir, 'a')), false);
  await waitFor(() => !pidAlive(pid), { what: 'unsandboxed chromium to exit' });
  assert.ok(fs.existsSync(profile('a')));
  await assert.rejects(manager.start('a'), (e) => e.code === 'SANDBOX_UNAVAILABLE');

  const ok = make();
  ok.manager.create('b');
  await ok.manager.setAllowUnsandboxed('b', true);
  await ok.manager.start('b');
  await ok.manager.setAllowUnsandboxed('b', false);
  assert.equal(ok.manager.summary('b').status, 'running');
  assert.equal(ok.manager.summary('b').sandbox, true);
});

// Invariant: a revoke is serialised with start per name, so a start already in flight cannot slip past it.
test('a revoke queued behind an in-flight start stops the browser that start produced', async () => {
  const { manager } = make({ env: NO_SANDBOX });
  manager.create('a');
  await manager.setAllowUnsandboxed('a', true);
  const started = manager.start('a');
  const revoked = manager.setAllowUnsandboxed('a', false);
  await Promise.all([started, revoked]);
  assert.equal(manager.summary('a').status, 'stopped');
  assert.equal(manager.summary('a').allowUnsandboxed, false);
});

// Invariant: an opt-in never outlives its browser: delete removes it, and a recreated name (even with a leftover
// file) starts without one.
test('delete removes the opt-in and create clears a leftover one', async () => {
  const { manager, dataDir } = make({ env: NO_SANDBOX });
  manager.create('a');
  await manager.setAllowUnsandboxed('a', true);
  await manager.delete('a');
  assert.equal(fs.existsSync(settingsOf(dataDir, 'a')), false);
  fs.writeFileSync(settingsOf(dataDir, 'a'), '{"allowUnsandboxed":true}');
  manager.create('a');
  assert.equal(fs.existsSync(settingsOf(dataDir, 'a')), false);
  assert.equal(manager.summary('a').allowUnsandboxed, false);
  await assert.rejects(manager.start('a'), (e) => e.code === 'SANDBOX_UNAVAILABLE');
});

// Invariant: setAllowUnsandboxed goes through the same name check and existence check as every other path.
test('setAllowUnsandboxed rejects bad and unknown names without touching the filesystem', async () => {
  const { manager, dataDir } = make();
  for (const bad of ['../x', 'A', '', null]) {
    await assert.rejects(manager.setAllowUnsandboxed(bad, true), (e) => e.code === 'INVALID_NAME', String(bad));
  }
  await assert.rejects(manager.setAllowUnsandboxed('ghost', true), (e) => e.code === 'NOT_FOUND');
  assert.equal(fs.existsSync(path.join(dataDir, 'settings')), false);
});

// Invariant: the sandbox stays on whenever Chromium can start with it.
test('a working sandbox is reported as sandbox true', async () => {
  const { manager } = make();
  manager.create('a');
  await manager.start('a');
  assert.equal(manager.summary('a').sandbox, true);
  assert.equal(manager.summary('a').allowUnsandboxed, false);
  assert.equal(manager.summary('a').sandboxUnavailable, false);
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

// Invariant: what the plugin writes under the data dir is private to the host user: the data dir, its top-level dirs,
// each profile root and each trash entry are 0700 (enforced on ones that already exist, at boot), run files, settings files and logs
// 0600. Files nested inside a profile are Chrome's own; the 0700 profile root shields them. The log holds visited URLs and the profile exposes CDP.
test('data tree is 0700 and run files and logs are 0600, including pre-existing ones', async () => {
  const dataDir = path.join(tmpDir(), '.code-browser');
  const preexisting = ['', 'profiles', 'profiles/old', 'logs', 'run', 'settings', 'trash', 'trash/old-1'];
  for (const d of preexisting) fs.mkdirSync(path.join(dataDir, d), { recursive: true, mode: 0o755 });
  for (const d of preexisting) fs.chmodSync(path.join(dataDir, d), 0o755);
  fs.writeFileSync(path.join(dataDir, 'logs', 'a.log'), 'old log', { mode: 0o644 });
  fs.chmodSync(path.join(dataDir, 'logs', 'a.log'), 0o644);
  fs.writeFileSync(settingsOf(dataDir, 'old'), '{"allowUnsandboxed":true}', { mode: 0o644 });
  fs.chmodSync(settingsOf(dataDir, 'old'), 0o644);
  const { manager, profile } = make({ dataDir });
  await manager.boot();
  for (const d of preexisting) assert.equal(modeOf(path.join(dataDir, d)), 0o700, `boot: ${d || '.code-browser'}`);
  assert.equal(modeOf(settingsOf(dataDir, 'old')), 0o600, 'a pre-existing settings file is tightened at boot');

  manager.create('a');
  await manager.start('a');
  for (const d of ['', 'profiles', 'logs', 'run', 'settings', 'trash']) {
    if (fs.existsSync(path.join(dataDir, d))) assert.equal(modeOf(path.join(dataDir, d)), 0o700, d || '.code-browser');
  }
  assert.equal(modeOf(profile('a')), 0o700);
  assert.equal(modeOf(path.join(profile('a'), 'Default')), 0o700);
  assert.equal(modeOf(path.join(dataDir, 'run', 'a.json')), 0o600);
  assert.equal(modeOf(path.join(dataDir, 'logs', 'a.log')), 0o600, 'a pre-existing log is tightened too');
  await manager.delete('a');
  assert.equal(modeOf(path.join(dataDir, 'trash')), 0o700);
});

// Invariant: a trash entry that vanishes between the listing and the chmod (an old backend's asynchronous rm during
// cc's restart overlap) does not fail boot, entries that remain are still tightened, and any other chmod error is not hidden.
test('boot tolerates a trash entry that vanishes mid-listing but not other errors', async () => {
  const dataDir = path.join(tmpDir(), '.code-browser');
  for (const d of ['trash/gone-1', 'trash/kept-1', 'trash/other-1']) fs.mkdirSync(path.join(dataDir, d), { recursive: true, mode: 0o755 });
  for (const d of ['trash/gone-1', 'trash/kept-1', 'trash/other-1']) fs.chmodSync(path.join(dataDir, d), 0o755);
  const vanish = (code) => (target, mode) => {
    if (target.endsWith('gone-1')) {
      fs.rmSync(target, { recursive: true });
      return fs.chmodSync(target, mode); // really ENOENT now
    }
    if (code && target.endsWith('other-1')) throw Object.assign(new Error('denied'), { code });
    return fs.chmodSync(target, mode);
  };
  for (const code of ['ENOENT', 'ENOTDIR']) {
    const e = Object.assign(new Error('gone'), { code });
    const { manager } = make({ dataDir, trashFs: { readdirSync: fs.readdirSync, chmodSync: (t, m) => { if (t.endsWith('gone-1')) throw e; return fs.chmodSync(t, m); } } });
    await manager.boot();
    assert.equal(modeOf(path.join(dataDir, 'trash', 'kept-1')), 0o700, `${code}: remaining entries are tightened`);
  }
  const real = make({ dataDir, trashFs: { readdirSync: fs.readdirSync, chmodSync: vanish() } });
  await real.manager.boot();
  assert.ok(!fs.existsSync(path.join(dataDir, 'trash', 'gone-1')));

  const { manager: strict } = make({ dataDir, trashFs: { readdirSync: fs.readdirSync, chmodSync: vanish('EACCES') } });
  await assert.rejects(strict.boot(), (err) => err.code === 'EACCES');
});
