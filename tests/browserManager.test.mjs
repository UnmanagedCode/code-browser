import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createBrowserManager } from '../src/browserManager.js';
import { CodedError, describeError } from '../src/errors.js';
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

// Invariant: a launch that never exposes DevToolsActivePort fails loudly with the log tail in details (and its rendering) and leaves no process.
test('launch timeout gives LAUNCH_FAILED with the log tail and kills the browser', async () => {
  // The launch clock stands still until the fake has started, then jumps past the deadline: the timeout fires, and
  // always on a browser that did start. A fake that never starts releases the clock after a real bound instead, and
  // the pid check below then fails the test.
  const dataDir = tmpDir();
  const t0 = Date.now();
  const started = () => fs.existsSync(path.join(dataDir, 'profiles', 'a', 'fake-pid'));
  const { manager, profile } = make({ dataDir, env: { FAKE_CHROMIUM_NO_PORT: '1' }, timeouts: { launch: 300 }, now: () => (started() || Date.now() - t0 > 10_000 ? Number.MAX_SAFE_INTEGER : 0) });
  manager.create('a');
  await assert.rejects(manager.start('a'), (e) => e.code === 'LAUNCH_FAILED' && /no DevToolsActivePort/.test(e.message)
    && typeof e.details.logTail === 'string' && describeError(e).includes('logTail:') && describeError(e).endsWith(e.details.logTail));
  assert.ok(started(), 'the fake started before the deadline fired');
  const pid = fakePid(profile('a'));
  await waitFor(() => !pidAlive(pid), { what: 'timed-out chromium to be killed' });
  assert.equal(manager.summary('a').status, 'stopped');
});

const NO_SANDBOX = { FAKE_CHROMIUM_REQUIRE_NO_SANDBOX: '1' };
const optInOf = (dataDir) => path.join(dataDir, 'allow-unsandboxed.json');
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
  assert.deepEqual(manager.summary('a'), { name: 'a', kind: 'launched', status: 'stopped', controller: 'agent', sandbox: null, sandboxUnavailable: true, lastExit: null, cdpEndpoint: null, attached: null, attachError: null });
  assert.equal(manager.allowsUnsandboxed(), false);
  assert.ok(changes > 0, 'the refusal emits change');
});

// Invariant: with the opt-in on, the unsandboxed relaunch happens, is logged, and reports sandbox false;
// a successful start clears the refusal flag.
test('sandbox failure with the opt-in relaunches with --no-sandbox and reports sandbox false', async () => {
  const { manager, warns, profile } = make({ env: NO_SANDBOX });
  manager.create('a');
  await assert.rejects(manager.start('a'), (e) => e.code === 'SANDBOX_UNAVAILABLE');
  await manager.setAllowUnsandboxed(true);
  assert.equal(manager.summary('a').sandboxUnavailable, true, 'granting alone does not hide the refusal until a start succeeds');
  await manager.start('a');
  const s = manager.summary('a');
  assert.equal(s.sandbox, false);
  assert.equal(s.sandboxUnavailable, false);
  assert.ok(JSON.parse(fs.readFileSync(path.join(profile('a'), 'fake-argv.json'), 'utf8')).includes('--no-sandbox'));
  assert.ok(warns.some((w) => w.includes('--no-sandbox')));
});

// Invariant: one grant covers every launched browser, persists on disk (a new manager on the same data dir sees it),
// in a file private to the host user that exists only while the opt-in is on.
test('one grant covers every launched browser, persists across managers, is private, exists only while on', async () => {
  const dataDir = tmpDir();
  const a = make({ dataDir, env: NO_SANDBOX });
  a.manager.create('a');
  a.manager.create('b');
  await a.manager.setAllowUnsandboxed(true);
  assert.equal(modeOf(optInOf(dataDir)), 0o600);
  await a.manager.start('a');
  await a.manager.start('b');
  assert.equal(a.manager.summary('a').sandbox, false);
  assert.equal(a.manager.summary('b').sandbox, false);
  const b = make({ dataDir });
  assert.equal(b.manager.allowsUnsandboxed(), true);
  assert.deepEqual(b.manager.overview().allowUnsandboxed, true);
  await b.manager.setAllowUnsandboxed(false);
  assert.equal(fs.existsSync(optInOf(dataDir)), false);
  await a.manager.shutdown();
});

// Invariant: an unreadable or malformed opt-in file counts as "not allowed" (refusing is the safe direction), loudly.
test('a malformed opt-in file is treated as not allowed and warned about', async () => {
  const { manager, dataDir, warns } = make({ env: NO_SANDBOX });
  manager.create('a');
  fs.writeFileSync(optInOf(dataDir), '{nope');
  assert.equal(manager.allowsUnsandboxed(), false);
  assert.ok(warns.some((w) => /malformed/.test(w)));
  await assert.rejects(manager.start('a'), (e) => e.code === 'SANDBOX_UNAVAILABLE');
});

// Invariant: a symlink at the opt-in path is never followed: it reads as "not allowed" (warned), granting replaces it
// with a fresh private file and writes nothing through it, revoking unlinks the link itself, and boot neither
// chmods the target nor fails.
test('a symlinked opt-in file is not honoured, written through or chmod-ed', async () => {
  const dataDir = tmpDir();
  const target = path.join(tmpDir(), 'victim.json');
  const plant = (content) => {
    fs.rmSync(optInOf(dataDir), { force: true });
    fs.writeFileSync(target, content, { mode: 0o644 });
    fs.chmodSync(target, 0o644);
    fs.symlinkSync(target, optInOf(dataDir));
  };
  const { manager, warns } = make({ dataDir, env: NO_SANDBOX });
  manager.create('a');

  plant('{"allowUnsandboxed":true}');
  assert.equal(manager.allowsUnsandboxed(), false);
  assert.ok(warns.some((w) => /symlink/.test(w)));
  await assert.rejects(manager.start('a'), (e) => e.code === 'SANDBOX_UNAVAILABLE');
  await manager.boot();
  assert.equal(modeOf(target), 0o644, 'boot did not chmod through the link');
  assert.equal(fs.lstatSync(optInOf(dataDir)).isSymbolicLink(), true);

  plant('keep me');
  await manager.setAllowUnsandboxed(true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep me', 'nothing was written through the link');
  assert.equal(fs.lstatSync(optInOf(dataDir)).isSymbolicLink(), false);
  assert.equal(modeOf(optInOf(dataDir)), 0o600);
  assert.equal(manager.allowsUnsandboxed(), true);

  plant('keep me');
  await manager.setAllowUnsandboxed(false);
  assert.equal(fs.existsSync(optInOf(dataDir)), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep me', 'revoking unlinked the link, not its target');
});

// Invariant: a FIFO at the opt-in path never blocks boot or the read: both return at once, the read is "not allowed",
// and the warning is the non-regular one (so the `fstat().isFile()` gate, not a later failure, rejected it). It runs
// in a child with a real kill timeout, because a blocking synchronous open would freeze this process's own timers.
test('a fifo at the opt-in path is rejected without blocking', () => {
  const dataDir = tmpDir();
  execFileSync('mkfifo', [optInOf(dataDir)]);
  const script = `
    import { allowsUnsandboxed, tightenOptIn } from ${JSON.stringify(new URL('../src/sandboxOptIn.js', import.meta.url).href)};
    const warns = [];
    const log = { warn: (m) => warns.push(m) };
    tightenOptIn(${JSON.stringify(dataDir)}, log);
    const allowed = allowsUnsandboxed(${JSON.stringify(dataDir)}, log);
    console.log(JSON.stringify({ allowed, warns }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
  assert.equal(r.error, undefined, `the child did not finish in time: ${r.error}`);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.allowed, false);
  assert.ok(out.warns.length >= 1 && out.warns.every((w) => /not a regular file/.test(w)), out.warns.join('\n'));
});

// Invariant: a directory at the opt-in path is rejected by the `fstat().isFile()` gate (the non-regular warning, not
// a read error), reads as "not allowed", fails no boot, and boot never chmods it.
test('a directory at the opt-in path is rejected as non-regular and left untouched by boot', async () => {
  const dataDir = tmpDir();
  fs.mkdirSync(optInOf(dataDir), { mode: 0o755 });
  fs.chmodSync(optInOf(dataDir), 0o755);
  const before = modeOf(optInOf(dataDir));
  const { manager, warns } = make({ dataDir, env: NO_SANDBOX });
  manager.create('a');
  await manager.boot();
  assert.equal(modeOf(optInOf(dataDir)), before, 'boot did not fchmod the directory');
  assert.equal(manager.allowsUnsandboxed(), false);
  assert.ok(warns.some((w) => /not a regular file/.test(w)));
  await assert.rejects(manager.start('a'), (e) => e.code === 'SANDBOX_UNAVAILABLE');
});

// Invariant: a Unix socket at the opt-in path (whose open fails with ENXIO) is "not allowed" with a warning and fails
// no boot.
test('a socket at the opt-in path is not allowed, warned about, and does not fail boot', async () => {
  const dataDir = tmpDir();
  const server = net.createServer();
  await new Promise((r) => server.listen(optInOf(dataDir), r));
  try {
    const { manager, warns } = make({ dataDir, env: NO_SANDBOX });
    manager.create('a');
    await manager.boot();
    assert.equal(manager.allowsUnsandboxed(), false);
    assert.ok(warns.some((w) => /could not open the sandbox opt-in/.test(w)));
    await assert.rejects(manager.start('a'), (e) => e.code === 'SANDBOX_UNAVAILABLE');
  } finally { server.close(); }
});

// Invariant: revoking consent takes effect now for every browser: each one running unsandboxed is stopped (profile
// kept, not a crash) and the next start is refused. A browser running sandboxed is left alone.
test('revoking stops every unsandboxed browser at once; sandboxed ones keep running', async () => {
  const { manager, dataDir, profile } = make({ env: NO_SANDBOX });
  manager.create('a');
  manager.create('b');
  await manager.setAllowUnsandboxed(true);
  await manager.start('a');
  await manager.start('b');
  const pids = ['a', 'b'].map((n) => fakePid(profile(n)));
  await manager.setAllowUnsandboxed(false);
  for (const n of ['a', 'b']) {
    const s = manager.summary(n);
    assert.equal(s.status, 'stopped');
    assert.equal(s.lastExit, null, 'a deliberate stop is not a crash');
    assert.ok(fs.existsSync(profile(n)));
  }
  assert.equal(fs.existsSync(optInOf(dataDir)), false);
  for (const pid of pids) await waitFor(() => !pidAlive(pid), { what: 'unsandboxed chromium to exit' });
  await assert.rejects(manager.start('a'), (e) => e.code === 'SANDBOX_UNAVAILABLE');

  const ok = make();
  ok.manager.create('c');
  await ok.manager.setAllowUnsandboxed(true);
  await ok.manager.start('c');
  await ok.manager.setAllowUnsandboxed(false);
  assert.equal(ok.manager.summary('c').status, 'running');
  assert.equal(ok.manager.summary('c').sandbox, true);
});

// Invariant: a start that has not yet reached its sandbox check when a revoke lands is refused there (the opt-in write
// is synchronous), launches nothing unsandboxed, and leaves the browser stopped.
test('a revoke issued before an in-flight start reaches its sandbox check refuses that start', async () => {
  const { manager, profile } = make({ env: NO_SANDBOX });
  manager.create('a');
  await manager.setAllowUnsandboxed(true);
  const started = manager.start('a');
  const revoked = manager.setAllowUnsandboxed(false);
  await assert.rejects(started, (e) => e.code === 'SANDBOX_UNAVAILABLE');
  await revoked;
  assert.equal(manager.summary('a').status, 'stopped');
  assert.equal(launchedUnsandboxed(profile('a')), false);
});

// Invariant: a start that already passed the sandbox check (held inside the --no-sandbox relaunch) finishes, and the
// revoke's queued per-name stop then stops the browser it produced: pid dead, not a crash, profile kept.
test('a revoke issued during the unsandboxed relaunch stops the browser that start produced', async () => {
  const release = path.join(tmpDir(), 'release');
  const { manager, profile } = make({ env: { ...NO_SANDBOX, FAKE_CHROMIUM_HOLD_PORT_UNTIL: release } });
  manager.create('a');
  await manager.setAllowUnsandboxed(true);
  const started = manager.start('a');
  // fake-argv.json exists only for the relaunch: the sandboxed launch exited before writing it.
  await waitFor(() => launchedUnsandboxed(profile('a')) && fs.existsSync(path.join(profile('a'), 'fake-pid')), { what: 'the unsandboxed relaunch to begin' });
  const pid = fakePid(profile('a'));
  const revoked = manager.setAllowUnsandboxed(false);
  fs.writeFileSync(release, '');
  await started;
  await revoked;
  const s = manager.summary('a');
  assert.equal(s.status, 'stopped');
  assert.equal(s.lastExit, null, 'a deliberate stop is not a crash');
  await waitFor(() => !pidAlive(pid), { what: 'the relaunched chromium to exit' });
  assert.ok(fs.existsSync(profile('a')));
});

// Invariant: a queued stop re-checks consent, so a grant that lands after a revoke but before its stops run keeps
// the browser running.
test('a grant issued after a revoke, before its queued stops run, keeps the browser running', async () => {
  const { manager, dataDir } = make({ env: NO_SANDBOX });
  manager.create('a');
  await manager.setAllowUnsandboxed(true);
  const started = manager.start('a');
  const revoked = manager.setAllowUnsandboxed(false);
  const granted = manager.setAllowUnsandboxed(true);
  await Promise.all([started, revoked, granted]);
  assert.equal(manager.summary('a').status, 'running');
  assert.ok(fs.existsSync(optInOf(dataDir)));
  await manager.shutdown();
});

// Invariant: the opt-in is not per browser: deleting or creating a browser leaves it alone.
test('deleting or creating a browser leaves the global opt-in alone', async () => {
  const { manager, dataDir } = make({ env: NO_SANDBOX });
  manager.create('a');
  await manager.setAllowUnsandboxed(true);
  await manager.delete('a');
  assert.ok(fs.existsSync(optInOf(dataDir)));
  manager.create('c');
  await manager.start('c');
  assert.equal(manager.summary('c').sandbox, false);
  await manager.shutdown();
});

// Invariant: the sandbox stays on whenever Chromium can start with it.
test('a working sandbox is reported as sandbox true', async () => {
  const { manager } = make();
  manager.create('a');
  await manager.start('a');
  assert.equal(manager.summary('a').sandbox, true);
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
// each profile root and each trash entry are 0700 (enforced on ones that already exist, at boot), run files, the opt-in file and logs
// 0600. Files nested inside a profile are Chrome's own; the 0700 profile root shields them. The log holds visited URLs and the profile exposes CDP.
test('data tree is 0700 and run files and logs are 0600, including pre-existing ones', async () => {
  const dataDir = path.join(tmpDir(), 'plugins', 'data', 'code-browser');
  const preexisting = ['', 'profiles', 'profiles/old', 'logs', 'run', 'trash', 'trash/old-1'];
  for (const d of preexisting) fs.mkdirSync(path.join(dataDir, d), { recursive: true, mode: 0o755 });
  for (const d of preexisting) fs.chmodSync(path.join(dataDir, d), 0o755);
  fs.writeFileSync(path.join(dataDir, 'logs', 'a.log'), 'old log', { mode: 0o644 });
  fs.chmodSync(path.join(dataDir, 'logs', 'a.log'), 0o644);
  fs.writeFileSync(optInOf(dataDir), '{"allowUnsandboxed":true}', { mode: 0o644 });
  fs.chmodSync(optInOf(dataDir), 0o644);
  const { manager, profile } = make({ dataDir });
  await manager.boot();
  for (const d of preexisting) assert.equal(modeOf(path.join(dataDir, d)), 0o700, `boot: ${d || 'data dir'}`);
  assert.equal(modeOf(optInOf(dataDir)), 0o600, 'a pre-existing opt-in file is tightened at boot');

  manager.create('a');
  await manager.start('a');
  for (const d of ['', 'profiles', 'logs', 'run', 'trash']) {
    if (fs.existsSync(path.join(dataDir, d))) assert.equal(modeOf(path.join(dataDir, d)), 0o700, d || 'data dir');
  }
  assert.equal(modeOf(profile('a')), 0o700);
  assert.equal(modeOf(path.join(profile('a'), 'Default')), 0o700);
  assert.equal(modeOf(path.join(dataDir, 'run', 'a.json')), 0o600);
  assert.equal(modeOf(path.join(dataDir, 'logs', 'a.log')), 0o600, 'a pre-existing log is tightened too');
  await manager.delete('a');
  assert.equal(modeOf(path.join(dataDir, 'trash')), 0o700);
});

// Invariant: cc never creates the data dir, so boot creates it and its missing parents, private (0700), with the secret.
test('boot creates a missing data dir and its missing parents, all 0700', async () => {
  const base = tmpDir();
  const dataDir = path.join(base, 'plugins', 'data', 'code-browser');
  assert.equal(fs.existsSync(dataDir), false);
  const { manager } = make({ dataDir });
  await manager.boot();
  for (const d of [dataDir, path.dirname(dataDir), path.join(base, 'plugins')]) assert.equal(modeOf(d), 0o700, d);
  assert.ok(fs.existsSync(path.join(dataDir, 'proxy', 'secret.json')));
});

// Invariant: a trash entry that vanishes between the listing and the chmod (an old backend's asynchronous rm during
// cc's restart overlap) does not fail boot, entries that remain are still tightened, and any other chmod error is not hidden.
test('boot tolerates a trash entry that vanishes mid-listing but not other errors', async () => {
  const dataDir = path.join(tmpDir(), 'data');
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

// Invariant: every start locates Chromium afresh, so a start that failed for want of Chromium succeeds once it is installed.
test('a start retried after CHROMIUM_NOT_FOUND locates again', async () => {
  let calls = 0;
  const manager = createBrowserManager({
    dataDir: tmpDir(),
    env: { ...process.env },
    log: { warn() {} },
    timeouts: { launch: 4000, stopGrace: 1500, killGrace: 200, shutdownGrace: 500 },
    locate: () => {
      calls += 1;
      if (calls === 1) throw new CodedError('CHROMIUM_NOT_FOUND', 'No Chromium found', { tried: [], install: 'npm run install-browser' });
      return FAKE;
    },
  });
  managers.push(manager);
  manager.create('a');
  await assert.rejects(manager.start('a'), (e) => e.code === 'CHROMIUM_NOT_FOUND');
  await manager.start('a');
  assert.equal(manager.summary('a').status, 'running');
  assert.equal(calls, 2);
});
