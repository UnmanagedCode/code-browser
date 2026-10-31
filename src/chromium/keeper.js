// Watchdog process: owns one Chromium so it can never outlive the backend.
//
//   node keeper.js <logFile> -- <chromium> <args…>
//
// stdout (JSON lines): {"chromiumPid":N}, later {"exit":{"code":..,"signal":..}}.
// stdin: a line `stop`, or EOF (the backend died, SIGKILL included), terminates Chromium's process group.
// The keeper is itself detached, so cc's process-group kill of the backend does not reach it first.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { KILL_GRACE_MS } from '../limits.js';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep !== 1 || argv.length < 3) {
  console.error('usage: keeper.js <logFile> -- <command> [args…]');
  process.exit(2);
}
const [logFile] = argv;
const [command, ...args] = argv.slice(sep + 1);

const log = fs.openSync(logFile, 'w', 0o600);
fs.fchmodSync(log, 0o600); // an existing log keeps its old mode otherwise
const child = spawn(command, args, { detached: true, stdio: ['ignore', log, log] });
const emit = (obj) => { try { process.stdout.write(`${JSON.stringify(obj)}\n`); } catch { /* backend gone */ } };
process.stdout.on('error', () => {});

let exited = false;
child.on('error', (err) => {
  fs.writeSync(log, `keeper: could not start ${command}: ${err.message}\n`);
  exited = true;
  emit({ exit: { code: null, signal: null, error: err.message } });
  process.exit(1);
});
child.on('exit', (code, signal) => {
  exited = true;
  emit({ exit: { code, signal } });
  setImmediate(() => process.exit(0));
});
if (child.pid) emit({ chromiumPid: child.pid });

let killing = false;
function killChild() {
  if (killing || exited) return;
  killing = true;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }, KILL_GRACE_MS).unref();
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line === 'stop') killChild();
  }
});
process.stdin.on('end', killChild);
process.stdin.on('error', killChild);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, killChild);
