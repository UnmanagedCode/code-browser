import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pluginDir } from '../config.js';
import { CodedError } from '../errors.js';
import { INSTALL_TIMEOUT_MS, LOG_TAIL_CHARS } from '../limits.js';
import { unrefTimeout } from '../schedule.js';
import { installCommand } from './locate.js';

// The arguments of playwright-core's CLI that `npm run install-browser` runs (package.json is pinned to the same).
export const INSTALL_ARGS = ['install', 'chromium'];

// Absolute path of playwright-core's own CLI script, resolved from the same package copy `locateChromium` asks
// for the executable path, so the install lands where the lookup stats.
export function resolveInstallerCli(dir = pluginDir) {
  try {
    const pkgPath = createRequire(path.join(dir, 'package.json')).resolve('playwright-core/package.json');
    const { bin } = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const rel = typeof bin === 'string' ? bin : bin['playwright-core'];
    return path.join(path.dirname(pkgPath), rel);
  } catch {
    throw new CodedError('INSTALL_UNAVAILABLE', 'playwright-core is not installed; run npm install', { install: installCommand(dir) });
  }
}

const idle = () => ({ status: 'idle', error: null, exitCode: null, logTail: '' });

// Runs `playwright-core install chromium` as a child of this process and holds the state of the latest run.
// The child is `node <cli>` with no shell: npm and npx are `.cmd` shims on Windows, which Node refuses to spawn
// without a shell, and a shell mis-quotes paths with spaces or `&`.
export function createChromiumInstaller({
  env = process.env,
  cwd = pluginDir,
  nodePath = process.execPath,
  resolveCli = resolveInstallerCli,
  spawn = nodeSpawn,
  schedule = unrefTimeout,
  timeoutMs = INSTALL_TIMEOUT_MS,
} = {}) {
  let current = idle();
  let child = null;
  let cancelTimer = null;
  let run = 0; // identifies the run whose events may still settle the state

  const settle = (id, patch) => {
    if (id !== run || current.status !== 'running') return;
    cancelTimer?.();
    cancelTimer = null;
    child = null;
    current = { ...current, ...patch };
  };

  function start() {
    if (current.status === 'running') throw new CodedError('INSTALL_RUNNING', 'a Chromium install is already running');
    const cli = resolveCli();
    const id = ++run;
    current = { status: 'running', error: null, exitCode: null, logTail: '' };
    const append = (chunk) => {
      if (id !== run) return;
      current.logTail = (current.logTail + chunk.replace(/\r\n?/g, '\n')).slice(-LOG_TAIL_CHARS);
    };
    let proc;
    try {
      proc = spawn(nodePath, [cli, ...INSTALL_ARGS], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd, env });
    } catch (err) {
      settle(id, { status: 'failed', error: `could not run the installer: ${err.message}` });
      return state();
    }
    child = proc;
    for (const stream of [proc.stdout, proc.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', append);
    }
    proc.on('error', (err) => settle(id, { status: 'failed', error: `could not run the installer: ${err.message}` }));
    proc.on('close', (code, signal) => {
      if (code === 0) settle(id, { status: 'succeeded', exitCode: 0 });
      else settle(id, { status: 'failed', exitCode: code, error: signal ? `the installer was killed by ${signal}` : `the installer exited with code ${code}` });
    });
    cancelTimer = schedule(() => {
      proc.kill();
      settle(id, { status: 'failed', error: `the install did not finish within ${Math.round(timeoutMs / 60_000)} minutes` });
    }, timeoutMs);
    return state();
  }

  const state = () => ({ ...current });
  // Shutdown: a running install must not outlive the backend.
  const close = () => { child?.kill(); };

  return { state, start, close };
}
