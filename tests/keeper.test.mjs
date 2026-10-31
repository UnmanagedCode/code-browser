import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pidAlive, tmpDir, waitFor } from './helpers.mjs';

const KEEPER = new URL('../src/chromium/keeper.js', import.meta.url).pathname;
// A fake "Chromium" that also has a child in its process group; both print their pids to the log.
const CHILD_SRC = `
const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e3)'], { stdio: 'ignore' });
console.log('PIDS ' + process.pid + ' ' + g.pid);
setInterval(()=>{},1e3);`;

// Every keeper a test starts is told to stop afterwards, so a failing test leaks nothing.
const started = [];
afterEach(() => { for (const k of started.splice(0)) k.stdin.end(); });

function startKeeper(extraArgs = [CHILD_SRC]) {
  const dir = tmpDir();
  const log = path.join(dir, 'log');
  const keeper = spawn(process.execPath, [KEEPER, log, '--', process.execPath, '-e', ...extraArgs], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
  started.push(keeper);
  const lines = [];
  readline.createInterface({ input: keeper.stdout }).on('line', (l) => lines.push(JSON.parse(l)));
  const exited = new Promise((r) => keeper.on('close', r));
  const pids = async () => {
    const m = await waitFor(() => { try { return /PIDS (\d+) (\d+)/.exec(fs.readFileSync(log, 'utf8')); } catch { return null; } }, { what: 'child pids in log' });
    return [Number(m[1]), Number(m[2])];
  };
  return { keeper, lines, exited, pids, log };
}

async function expectGroupDead(pids) {
  for (const pid of pids) await waitFor(() => !pidAlive(pid), { what: `pid ${pid} to die` });
}

// Invariant: stdin EOF (the backend died) takes down Chromium's whole process group and the keeper itself.
test('stdin EOF kills the child group and exits', async () => {
  const k = startKeeper();
  const pids = await k.pids();
  k.keeper.stdin.end();
  await expectGroupDead(pids);
  await k.exited;
  assert.ok(k.lines.some((l) => l.chromiumPid === pids[0]));
  assert.ok(k.lines.some((l) => l.exit?.signal === 'SIGTERM'));
});

// Invariant: an explicit `stop` line does the same as EOF.
test('a stop line kills the child group', async () => {
  const k = startKeeper();
  const pids = await k.pids();
  k.keeper.stdin.write('stop\n');
  await expectGroupDead(pids);
  await k.exited;
});

// Invariant: SIGTERM to the keeper (e.g. a manual kill) also takes the browser down.
test('SIGTERM kills the child group', async () => {
  const k = startKeeper();
  const pids = await k.pids();
  k.keeper.kill('SIGTERM');
  await expectGroupDead(pids);
  await k.exited;
});

// Invariant: when the Chromium exits by itself the keeper reports the exit status and exits.
test('child exit is reported with its code', async () => {
  const k = startKeeper(['process.exit(7)']);
  await k.exited;
  assert.deepEqual(k.lines.at(-1), { exit: { code: 7, signal: null } });
});

// Invariant: a backend killed with SIGKILL leaves no browser behind (the keeper sees stdin close).
test('killing the parent with SIGKILL leaves no child', async () => {
  const dir = tmpDir();
  const log = path.join(dir, 'log');
  const parentSrc = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, [${JSON.stringify(KEEPER)}, ${JSON.stringify(log)}, '--', process.execPath, '-e', ${JSON.stringify(CHILD_SRC)}], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    setInterval(()=>{},1e3);`;
  const parent = spawn(process.execPath, ['-e', parentSrc], { stdio: 'ignore' });
  const m = await waitFor(() => { try { return /PIDS (\d+) (\d+)/.exec(fs.readFileSync(log, 'utf8')); } catch { return null; } }, { what: 'child pids' });
  const pids = [Number(m[1]), Number(m[2])];
  assert.ok(pids.every(pidAlive));
  parent.kill('SIGKILL');
  await expectGroupDead(pids);
});
