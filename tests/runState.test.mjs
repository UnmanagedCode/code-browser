import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pidAlive, readRun, reap, runNames, writeRun } from '../src/runState.js';
import { tmpDir, waitFor } from './helpers.mjs';

const KEEPER = '/plugin/src/chromium/keeper.js';
const procs = [];
afterEach(() => { for (const p of procs.splice(0)) try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } });

// A detached process (its own group, like a real Chromium) whose cmdline carries the given arguments.
function startProc(...extra) {
  const p = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e3)', '--', ...extra], { detached: true, stdio: 'ignore' });
  procs.push(p);
  return p;
}

// Invariant: reap kills a recorded pid whose cmdline still names this profile, and clears the run file.
test('reap kills a live pid with a matching cmdline', async () => {
  const dataDir = tmpDir();
  const profileDir = path.join(dataDir, 'profiles', 'a');
  const p = startProc(`--user-data-dir=${profileDir}`);
  writeRun(dataDir, 'a', { keeperPid: null, chromiumPid: p.pid, startedAt: 1 });
  assert.deepEqual(await reap(dataDir, 'a', { profileDir, keeperPath: KEEPER }), [p.pid]);
  await waitFor(() => !pidAlive(p.pid), { what: 'process to die' });
  assert.equal(readRun(dataDir, 'a'), null);
});

// Invariant: a recycled pid is never killed: the cmdline must carry exactly this profile's --user-data-dir token,
// so profile `ab` (a prefix extension of `a`) is not mistaken for `a`.
test('reap leaves a live Chromium of a prefix-colliding profile alone', async () => {
  const dataDir = tmpDir();
  const profileDir = path.join(dataDir, 'profiles', 'a');
  const other = startProc(`--user-data-dir=${path.join(dataDir, 'profiles', 'ab')}`);
  writeRun(dataDir, 'a', { keeperPid: null, chromiumPid: other.pid, startedAt: 1 });
  assert.deepEqual(await reap(dataDir, 'a', { profileDir, keeperPath: KEEPER }), []);
  assert.ok(pidAlive(other.pid));
  assert.equal(readRun(dataDir, 'a'), null, 'the stale run file is still cleared');
});

// Invariant: the same exactness holds for the keeper: profile `ab`'s keeper, and a different script path that merely
// starts with the keeper's, are left alone; the real keeper of `a` is killed.
test('reap matches the keeper by whole argv tokens', async () => {
  const dataDir = tmpDir();
  const profileDir = path.join(dataDir, 'profiles', 'a');
  const userDir = (n) => `--user-data-dir=${path.join(dataDir, 'profiles', n)}`;
  const wrongProfile = startProc(KEEPER, userDir('ab'));
  const wrongScript = startProc(`${KEEPER}.bak`, userDir('a'));
  const right = startProc(KEEPER, userDir('a'));
  for (const [p, expected] of [[wrongProfile, []], [wrongScript, []], [right, [right.pid]]]) {
    writeRun(dataDir, 'a', { keeperPid: p.pid, chromiumPid: null, startedAt: 1 });
    assert.deepEqual(await reap(dataDir, 'a', { profileDir, keeperPath: KEEPER }), expected);
  }
  await waitFor(() => !pidAlive(right.pid), { what: 'the real keeper to die' });
  assert.ok(pidAlive(wrongProfile.pid));
  assert.ok(pidAlive(wrongScript.pid));
});

// Invariant: the keeper is only killed when its cmdline names the keeper script as well as the profile.
test('a pid naming the profile but not the keeper script is not taken for the keeper', async () => {
  const dataDir = tmpDir();
  const profileDir = path.join(dataDir, 'profiles', 'a');
  const p = startProc(`--user-data-dir=${profileDir}`);
  writeRun(dataDir, 'a', { keeperPid: p.pid, chromiumPid: null, startedAt: 1 });
  assert.deepEqual(await reap(dataDir, 'a', { profileDir, keeperPath: KEEPER }), []);
  assert.ok(pidAlive(p.pid));
});

// Invariant: dead pids and a missing run file are no-ops, not errors.
test('reap tolerates dead pids and absent state', async () => {
  const dataDir = tmpDir();
  const profileDir = path.join(dataDir, 'profiles', 'a');
  assert.deepEqual(await reap(dataDir, 'a', { profileDir, keeperPath: KEEPER }), []);
  writeRun(dataDir, 'a', { keeperPid: 2 ** 22 + 1, chromiumPid: 2 ** 22 + 2, startedAt: 1 });
  assert.deepEqual(await reap(dataDir, 'a', { profileDir, keeperPath: KEEPER }), []);
  assert.deepEqual(runNames(dataDir), []);
});
