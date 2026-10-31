import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir, writePrivateFile } from './fsPrivate.js';
import { POLL_MS } from './limits.js';

export const runFile = (dataDir, name) => path.join(dataDir, 'run', `${name}.json`);

export function writeRun(dataDir, name, state) {
  ensurePrivateDir(path.join(dataDir, 'run'));
  writePrivateFile(runFile(dataDir, name), JSON.stringify(state));
}

export function readRun(dataDir, name) {
  try { return JSON.parse(fs.readFileSync(runFile(dataDir, name), 'utf8')); } catch { return null; }
}

export const removeRun = (dataDir, name) => fs.rmSync(runFile(dataDir, name), { force: true });

export function runNames(dataDir) {
  try {
    return fs.readdirSync(path.join(dataDir, 'run')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch { return []; }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// The process's argv, one token per entry.
const argvOf = (pid) => {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return []; }
};

async function waitDead(pid, ms) {
  const deadline = Date.now() + ms;
  while (pidAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, POLL_MS));
}

// Kill whatever a previous backend left behind for `name`. A recorded pid is only killed when its argv
// still carries this profile's --user-data-dir token (and, for the keeper, the keeper script) as a whole
// token: a recycled pid, or the profile `ab` when reaping `a`, is left alone.
export async function reap(dataDir, name, { profileDir, keeperPath }) {
  const state = readRun(dataDir, name);
  const killed = [];
  if (state) {
    const userDir = `--user-data-dir=${profileDir}`;
    const targets = [
      [state.keeperPid, (argv) => argv.includes(keeperPath) && argv.includes(userDir)],
      [state.chromiumPid, (argv) => argv.includes(userDir)],
    ];
    for (const [pid, matches] of targets) {
      if (!pidAlive(pid) || !matches(argvOf(pid))) continue;
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      killed.push(pid);
      await waitDead(pid, 2000);
    }
  }
  removeRun(dataDir, name);
  return killed;
}
