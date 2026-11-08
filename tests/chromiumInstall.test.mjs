import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_ARGS, createChromiumInstaller, resolveInstallerCli } from '../src/chromium/install.js';
import { pluginDir } from '../src/config.js';
import { LOG_TAIL_CHARS } from '../src/limits.js';
import { tmpDir, waitFor } from './helpers.mjs';

const FAKE_SRC = fileURLToPath(new URL('./fakes/fakeInstallerCli.cjs', import.meta.url));
const installers = [];

function make({ env = {}, ...over } = {}) {
  const dir = tmpDir();
  const cli = path.join(dir, 'cli.cjs');
  fs.copyFileSync(FAKE_SRC, cli);
  const installer = createChromiumInstaller({ env: { ...process.env, ...env }, cwd: dir, resolveCli: () => cli, ...over });
  installers.push(installer);
  return { installer, cli, dir };
}
const settled = (installer) => waitFor(() => installer.state().status !== 'running' && installer.state(), { what: 'install to settle' });
afterEach(() => { for (const i of installers.splice(0)) i.close(); });

// Invariant: the installer runs node on the CLI script with no shell and exactly INSTALL_ARGS, even when the path has a space or backslash.
test('spawns execPath with the script path as one argv element, no shell, no .cmd', async () => {
  const dir = tmpDir();
  const parts = process.platform === 'win32' ? ['with space'] : ['with space', 'back\\slash'];
  const cliDir = path.join(dir, ...parts);
  fs.mkdirSync(cliDir, { recursive: true });
  const cli = path.join(cliDir, 'cli.cjs');
  fs.copyFileSync(FAKE_SRC, cli);
  const argvFile = path.join(dir, 'argv.json');
  const seen = [];
  const installer = createChromiumInstaller({
    env: { ...process.env, FAKE_INSTALL_ARGV: argvFile },
    cwd: dir,
    resolveCli: () => cli,
    spawn: (file, args, opts) => { seen.push({ file, args, opts }); return realSpawn(file, args, opts); },
  });
  installers.push(installer);
  installer.start();
  assert.equal((await settled(installer)).status, 'succeeded');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].file, process.execPath);
  assert.ok(!seen[0].opts.shell, 'no shell');
  assert.deepEqual(seen[0].args, [cli, ...INSTALL_ARGS]);
  assert.ok(![seen[0].file, ...seen[0].args].some((a) => /\.(cmd|bat)$/i.test(a)));
  const recorded = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  assert.equal(recorded.script, cli);
  assert.deepEqual(recorded.args, INSTALL_ARGS);
});

// Invariant: a run goes idle → running → succeeded on exit 0, and failed (naming the code, keeping the log) otherwise.
test('state transitions: success and failure', async () => {
  const ok = make();
  assert.equal(ok.installer.state().status, 'idle');
  assert.equal(ok.installer.start().status, 'running');
  const done = await settled(ok.installer);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.error, null);
  assert.equal(done.exitCode, 0);

  const bad = make({ env: { FAKE_INSTALL_EXIT: '3' } });
  bad.installer.start();
  const failed = await settled(bad.installer);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /code 3/);
  assert.equal(failed.exitCode, 3);
  assert.ok(failed.logTail.includes('done-marker'));
  assert.ok(!failed.logTail.includes('\r'), 'carriage returns are normalized');
});

// Invariant: state() returns a copy a caller cannot use to alter the installer.
test('state() is a copy', () => {
  const { installer } = make();
  installer.state().status = 'failed';
  assert.equal(installer.state().status, 'idle');
});

// Invariant: the log tail never exceeds LOG_TAIL_CHARS and keeps the newest output.
test('log tail is capped and keeps the end', async () => {
  const { installer } = make({ env: { FAKE_INSTALL_LINES: '2000' } });
  installer.start();
  const s = await settled(installer);
  assert.ok(s.logTail.length <= LOG_TAIL_CHARS);
  assert.ok(s.logTail.trimEnd().endsWith('done-marker'));
});

// Invariant: one install at a time; after it settles a new run is accepted and its log starts empty.
test('a second start while running is refused; a later one resets the log', async () => {
  const { installer } = make();
  installer.start();
  assert.throws(() => installer.start(), (e) => e.code === 'INSTALL_RUNNING');
  await settled(installer);
  assert.equal(installer.start().logTail, '');
  assert.equal((await settled(installer)).status, 'succeeded');
});

// Invariant: a run that outlives its deadline is killed and reported failed, and the later close event does not overwrite that.
test('timeout kills the child and stays failed', async () => {
  let fire;
  let child;
  const { installer } = make({
    env: { FAKE_INSTALL_HANG: '1' },
    schedule: (fn) => { fire = fn; return () => {}; },
    spawn: (...a) => { child = realSpawn(...a); return child; },
  });
  installer.start();
  await waitFor(() => installer.state().logTail.includes('done-marker'), { what: 'child output' });
  fire();
  assert.equal(installer.state().status, 'failed');
  assert.match(installer.state().error, /did not finish within \d+ minutes/);
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, { what: 'child killed' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(installer.state().status, 'failed');
  assert.match(installer.state().error, /did not finish/);
});

// Invariant: a spawn that cannot start settles the run as failed instead of throwing or hanging.
test('spawn error fails the run', async () => {
  const { installer } = make({ nodePath: path.join(tmpDir(), 'no-such-node') });
  installer.start();
  const s = await settled(installer);
  assert.equal(s.status, 'failed');
  assert.match(s.error, /could not run the installer/);
});

// Invariant: shutdown kills a running installer rather than orphaning it.
test('close() kills a running child', async () => {
  let child;
  const { installer } = make({ env: { FAKE_INSTALL_HANG: '1' }, spawn: (...a) => { child = realSpawn(...a); return child; } });
  installer.start();
  installer.close();
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, { what: 'child killed' });
});

// Invariant: the CLI is resolved from playwright-core (the copy locate checks); a missing package is a coded error carrying the manual command.
test('resolveInstallerCli finds playwright-core, and fails with INSTALL_UNAVAILABLE without it', () => {
  const cli = resolveInstallerCli();
  assert.ok(fs.statSync(cli).isFile());
  assert.ok(cli.includes(`playwright-core${path.sep}`));
  assert.throws(() => resolveInstallerCli(tmpDir()), (e) => e.code === 'INSTALL_UNAVAILABLE' && typeof e.details.install === 'string');
});

// Invariant: the install arguments have one source: package.json's install-browser script is the same command.
test('INSTALL_ARGS match the install-browser script', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['install-browser'], `playwright-core ${INSTALL_ARGS.join(' ')}`);
});

// Invariant: a pipe error on the installer's output streams is absorbed, never an uncaught exception.
test('an error event on stdout or stderr does not escape', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const { installer } = make({ spawn: () => child });
  installer.start();
  child.stdout.emit('error', new Error('EPIPE'));
  child.stderr.emit('error', new Error('EPIPE'));
  child.emit('close', 0, null);
  assert.equal(installer.state().status, 'succeeded');
});

// Invariant: by default the child inherits the backend's working directory (not the plugin dir), so a relative PLAYWRIGHT_BROWSERS_PATH resolves as in the backend's lookup.
test('the child runs in the backend cwd by default', async () => {
  const dir = tmpDir();
  const cli = path.join(dir, 'cli.cjs');
  fs.copyFileSync(FAKE_SRC, cli);
  const argvFile = path.join(dir, 'argv.json');
  const backendCwd = fs.realpathSync(tmpDir());
  const before = process.cwd();
  process.chdir(backendCwd);
  try {
    const installer = createChromiumInstaller({ env: { ...process.env, FAKE_INSTALL_ARGV: argvFile }, resolveCli: () => cli });
    installers.push(installer);
    installer.start();
    assert.equal((await settled(installer)).status, 'succeeded');
  } finally {
    process.chdir(before);
  }
  const seen = JSON.parse(fs.readFileSync(argvFile, 'utf8')).cwd;
  assert.equal(fs.realpathSync(seen), backendCwd);
  assert.notEqual(fs.realpathSync(seen), fs.realpathSync(pluginDir));
});
