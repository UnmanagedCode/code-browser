// Spawns the real `node server.js`. Every env names a fixture PROJECTS_ROOT and CONDUCTOR_PLUGIN_DATA_DIR: agent
// shells export the real PROJECTS_ROOT, and an inherited one would make the boot migration move the real store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { storeDir, tmpDir, waitFor, waitForExit } from './helpers.mjs';

const root = new URL('..', import.meta.url).pathname;
const live = new Set();
process.once('exit', () => { for (const c of live) c.kill('SIGKILL'); });

// A secret boot's ensureSecret accepts as valid, so only the migration (not boot) can explain finding it at the target.
const LEGACY_SECRET = `${JSON.stringify({ protocolVersion: 1, secret: 'legacy-secret-legacy-secret-legacy-secret' })}\n`;

function seed(projectsRoot) {
  const legacy = path.join(projectsRoot, '.code-browser');
  fs.mkdirSync(path.join(legacy, 'proxy'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'proxy', 'secret.json'), LEGACY_SECRET);
  return legacy;
}

// `unset` names inherited variables to drop. `exited(ms)` waits for the close (stdio drained) and SIGKILLs and rejects
// on timeout; `stop()` always leaves the child dead, so no test can leave a backend running.
function run(env, { unset = [] } = {}) {
  const full = { ...process.env, PORT: '0', ...env };
  for (const k of unset) delete full[k];
  const proc = spawn(process.execPath, ['server.js'], { cwd: root, env: full, stdio: ['ignore', 'pipe', 'pipe'] });
  live.add(proc);
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const closed = new Promise((r) => proc.once('close', r)).then((code) => { live.delete(proc); return code; });
  return {
    proc,
    out: () => out,
    exited: (ms = 10_000) => waitForExit(proc, ms, 'the backend'),
    async stop() { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); await closed; },
  };
}

function tree(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8'); } };
  walk(dir);
  return out;
}

// Invariant: the migration runs before boot creates the store, so the legacy secret (not a fresh one) is what the moved store holds.
test('the migration runs before boot creates the store', async () => {
  const projectsRoot = tmpDir();
  const legacy = seed(projectsRoot);
  const target = storeDir(projectsRoot);
  const b = run({ PROJECTS_ROOT: projectsRoot, CONDUCTOR_PLUGIN_DATA_DIR: target });
  try {
    await waitFor(() => /listening on 127\.0\.0\.1:\d+/.test(b.out()), { what: 'backend to listen', timeout: 10_000 });
    assert.ok(b.out().includes(`(data: ${target})`));
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(fs.readFileSync(path.join(target, 'proxy', 'secret.json'), 'utf8'), LEGACY_SECRET);
    b.proc.kill('SIGTERM');
    assert.equal(await b.exited(), 0, 'SIGTERM shuts the backend down cleanly');
  } finally {
    await b.stop();
  }
});

// Invariant: a failed migration stops the backend before it listens and changes nothing on disk.
test('a failed migration refuses to boot', async () => {
  const projectsRoot = tmpDir();
  const legacy = seed(projectsRoot);
  const target = storeDir(projectsRoot);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'keep.txt'), 'mine');
  const [l, t] = [tree(legacy), tree(target)];
  const b = run({ PROJECTS_ROOT: projectsRoot, CONDUCTOR_PLUGIN_DATA_DIR: target });
  try {
    assert.notEqual(await b.exited(), 0);
    assert.doesNotMatch(b.out(), /listening/);
    assert.ok(b.out().includes(legacy) && b.out().includes(target));
  } finally {
    await b.stop();
  }
  assert.deepEqual(tree(legacy), l);
  assert.deepEqual(tree(target), t);
});

// Invariant: without CONDUCTOR_PLUGIN_DATA_DIR the backend refuses to start and creates nothing.
test('a missing data-dir variable refuses to boot', async () => {
  const projectsRoot = tmpDir();
  const b = run({ PROJECTS_ROOT: projectsRoot }, { unset: ['CONDUCTOR_PLUGIN_DATA_DIR'] });
  try {
    assert.notEqual(await b.exited(), 0);
    assert.match(b.out(), /CONDUCTOR_PLUGIN_DATA_DIR is not set/);
    assert.deepEqual(fs.readdirSync(projectsRoot), []);
  } finally {
    await b.stop();
  }
});
