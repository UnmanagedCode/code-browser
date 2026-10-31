import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { CdpConnection } from './cdp.js';
import { buildArgs, isSandboxFailure } from './chromium/args.js';
import { locateChromium } from './chromium/locate.js';
import { pluginDir } from './config.js';
import { ensurePrivateDir, PRIVATE_DIR_MODE } from './fsPrivate.js';
import { CodedError } from './errors.js';
import { CDP_TIMEOUT_MS, KILL_GRACE_MS, LAUNCH_TIMEOUT_MS, LOG_SCAN_CHARS, LOG_TAIL_CHARS, NAME_RE, POLL_MS, SHUTDOWN_GRACE_MS, STOP_GRACE_MS } from './limits.js';
import { pidAlive, reap, removeRun, runNames, writeRun } from './runState.js';

const KEEPER = path.join(pluginDir, 'src', 'chromium', 'keeper.js');
const SINGLETONS = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort'];
const NEW_PROFILE_PREFS = { session: { restore_on_startup: 1 } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new CodedError('INVALID_NAME', `invalid browser name (expected ${NAME_RE}): ${JSON.stringify(name)}`);
  }
  return name;
}

// Owns the browsers: profiles on disk, the keeper+Chromium processes, one CDP connection each.
// Emits 'change' whenever a browser's list-visible state changes and 'started'/'exited' (entry) for sessions.
export function createBrowserManager({
  dataDir,
  locate = locateChromium,
  env = process.env,
  log = console,
  timeouts = {},
  createSession = null,
} = {}) {
  const t = { launch: LAUNCH_TIMEOUT_MS, stopGrace: STOP_GRACE_MS, killGrace: KILL_GRACE_MS, shutdownGrace: SHUTDOWN_GRACE_MS, ...timeouts };
  const events = new EventEmitter();
  const profilesDir = path.join(dataDir, 'profiles');
  const logsDir = path.join(dataDir, 'logs');
  const trashDir = path.join(dataDir, 'trash');
  const profileOf = (name) => path.join(profilesDir, name);
  const running = new Map();
  const lastExit = new Map();
  const locks = new Map();

  const profileExists = (name) => fs.statSync(profileOf(name), { throwIfNoEntry: false })?.isDirectory() === true;
  const requireProfile = (name) => {
    assertName(name);
    if (!profileExists(name)) throw new CodedError('NOT_FOUND', `no browser named '${name}'`);
  };

  // One operation at a time per browser name.
  function withLock(name, fn) {
    const prev = locks.get(name) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    locks.set(name, tail);
    tail.then(() => { if (locks.get(name) === tail) locks.delete(name); });
    return next;
  }

  function names() {
    try {
      return fs.readdirSync(profilesDir, { withFileTypes: true }).filter((d) => d.isDirectory() && NAME_RE.test(d.name)).map((d) => d.name).sort();
    } catch { return []; }
  }

  function summary(name) {
    requireProfile(name);
    const entry = running.get(name);
    return {
      name,
      status: entry ? 'running' : 'stopped',
      controller: entry?.session?.controller.kind() ?? 'agent',
      sandbox: entry ? entry.sandbox : null,
      lastExit: entry ? null : lastExit.get(name) ?? null,
      cdpEndpoint: entry ? `http://127.0.0.1:${entry.port}` : null,
    };
  }

  function create(name) {
    assertName(name);
    ensurePrivateDir(dataDir);
    ensurePrivateDir(profilesDir);
    try { fs.mkdirSync(profileOf(name), { mode: PRIVATE_DIR_MODE }); } catch (err) {
      if (err.code === 'EEXIST') throw new CodedError('EXISTS', `a browser named '${name}' already exists`);
      throw err;
    }
    fs.chmodSync(profileOf(name), PRIVATE_DIR_MODE);
    ensurePrivateDir(path.join(profileOf(name), 'Default'));
    fs.writeFileSync(path.join(profileOf(name), 'Default', 'Preferences'), JSON.stringify(NEW_PROFILE_PREFS));
    events.emit('change');
    return { name };
  }

  function ensure(name) {
    assertName(name);
    return profileExists(name) ? { name } : create(name);
  }

  // The sandbox message opens a long crash dump, so detection reads the head of the log, not its tail.
  const readLog = (logFile) => {
    try { return fs.readFileSync(logFile, 'utf8').slice(0, LOG_SCAN_CHARS); } catch { return ''; }
  };

  function spawnKeeper(chrome, args, logFile) {
    const child = spawn(process.execPath, [KEEPER, logFile, '--', chrome, ...args], { detached: true, stdio: ['pipe', 'pipe', 'ignore'], env });
    child.stdin.on('error', () => {});
    const handle = { child, chromiumPid: null, exit: null, done: false };
    handle.exited = new Promise((resolve) => {
      child.on('close', (code, signal) => {
        handle.done = true;
        handle.exit ??= { code, signal };
        resolve(handle.exit);
      });
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.chromiumPid) handle.chromiumPid = msg.chromiumPid;
      if (msg.exit) handle.exit = msg.exit;
    });
    child.on('error', () => { handle.done = true; });
    return handle;
  }

  async function killHandle(handle) {
    if (handle.done) return;
    try { handle.child.stdin.write('stop\n'); } catch { /* keeper already gone */ }
    await Promise.race([handle.exited, sleep(t.killGrace + 1000)]);
    if (handle.done) return;
    for (const pid of [handle.child.pid, handle.chromiumPid]) {
      if (pid && pidAlive(pid)) try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    }
    await Promise.race([handle.exited, sleep(1000)]);
  }

  async function readDevToolsPort(profileDir, handle) {
    const file = path.join(profileDir, 'DevToolsActivePort');
    const deadline = Date.now() + t.launch;
    while (Date.now() < deadline) {
      let lines = null;
      try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { /* not yet */ }
      if (lines && lines[0] && lines[1]) return { port: Number(lines[0]), wsPath: lines[1] };
      if (handle.done) return null;
      await sleep(POLL_MS);
    }
    return undefined;
  }

  async function launch(name, chrome, sandbox) {
    const profileDir = profileOf(name);
    const logFile = path.join(logsDir, `${name}.log`);
    for (const f of SINGLETONS) fs.rmSync(path.join(profileDir, f), { force: true });
    const handle = spawnKeeper(chrome, buildArgs({ profileDir, sandbox }), logFile);
    const found = await readDevToolsPort(profileDir, handle);
    if (found) return { handle, ...found, sandbox };
    const timedOut = found === undefined;
    if (timedOut) await killHandle(handle);
    const log = readLog(logFile);
    return { failed: { timedOut, tail: log.slice(-LOG_TAIL_CHARS), sandboxFailure: !timedOut && sandbox && isSandboxFailure(log) } };
  }

  async function doStart(name) {
    requireProfile(name);
    if (running.has(name)) return;
    const profileDir = profileOf(name);
    const chrome = locate(env);
    ensurePrivateDir(logsDir);
    await reap(dataDir, name, { profileDir, keeperPath: KEEPER });
    let result = await launch(name, chrome, true);
    if (result.failed?.sandboxFailure) {
      log.warn(`code-browser: '${name}' has no usable Chromium sandbox; relaunching with --no-sandbox`);
      result = await launch(name, chrome, false);
    }
    if (result.failed) {
      const why = result.failed.timedOut ? `no DevToolsActivePort within ${t.launch} ms` : 'Chromium exited during launch';
      throw new CodedError('LAUNCH_FAILED', `${why}. Log tail:\n${result.failed.tail}`);
    }
    const { handle, port, wsPath, sandbox } = result;
    writeRun(dataDir, name, { keeperPid: handle.child.pid, chromiumPid: handle.chromiumPid, startedAt: Date.now() });
    let cdp;
    try {
      cdp = await CdpConnection.connect(`ws://127.0.0.1:${port}${wsPath}`);
    } catch (err) {
      await killHandle(handle);
      removeRun(dataDir, name);
      throw new CodedError('LAUNCH_FAILED', `could not connect to CDP on port ${port}: ${err.message}`);
    }
    const entry = { name, handle, cdp, port, sandbox, startedAt: Date.now(), stopping: false };
    running.set(name, entry);
    lastExit.delete(name);
    handle.exited.then((exit) => onExit(entry, exit));
    if (createSession) {
      entry.session = createSession(entry);
      try {
        await entry.session.start();
      } catch (err) {
        entry.stopping = true;
        await killHandle(handle);
        onExit(entry, handle.exit);
        throw new CodedError('LAUNCH_FAILED', `could not start the browser session: ${err.message}`);
      }
      entry.session.events.on('change', () => events.emit('change'));
    }
    events.emit('started', entry);
    events.emit('change');
  }

  function onExit(entry, exit) {
    if (running.get(entry.name) !== entry) return;
    running.delete(entry.name);
    entry.session?.dispose();
    entry.cdp.close();
    removeRun(dataDir, entry.name);
    if (!entry.stopping) {
      lastExit.set(entry.name, { code: exit?.code ?? null, signal: exit?.signal ?? null, at: Date.now() });
      log.warn(`code-browser: '${entry.name}' exited unexpectedly (code ${exit?.code}, signal ${exit?.signal})`);
    }
    events.emit('exited', entry);
    events.emit('change');
  }

  // Summary plus the open tabs and the active one.
  function info(name) {
    const base = summary(name);
    const entry = running.get(name);
    if (!entry?.session) throw new CodedError('NOT_RUNNING', `browser '${name}' is stopped; call start_browser first`);
    return { ...base, ...entry.session.info() };
  }

  async function doStop(name) {
    requireProfile(name);
    const entry = running.get(name);
    if (!entry) return;
    entry.stopping = true;
    try { await entry.cdp.send('Browser.close', {}, { timeoutMs: Math.min(CDP_TIMEOUT_MS, t.stopGrace) }); } catch { /* the kill path below handles it */ }
    await Promise.race([entry.handle.exited, sleep(t.stopGrace)]);
    if (!entry.handle.done) await killHandle(entry.handle);
    onExit(entry, entry.handle.exit);
  }

  async function doDelete(name) {
    requireProfile(name);
    await doStop(name);
    ensurePrivateDir(trashDir);
    const dest = path.join(trashDir, `${name}-${Date.now()}`);
    fs.renameSync(profileOf(name), dest);
    lastExit.delete(name);
    fsp.rm(dest, { recursive: true, force: true }).catch((err) => log.warn(`code-browser: could not remove ${dest}: ${err.message}`));
    events.emit('change');
  }

  // Backend boot: nothing outlives the previous backend, so every leftover is killed.
  async function boot() {
    for (const dir of [dataDir, profilesDir, logsDir, path.join(dataDir, 'run')]) ensurePrivateDir(dir);
    for (const name of names()) fs.chmodSync(profileOf(name), PRIVATE_DIR_MODE);
    const all = new Set([...names(), ...runNames(dataDir)]);
    for (const name of all) {
      if (NAME_RE.test(name)) await reap(dataDir, name, { profileDir: profileOf(name), keeperPath: KEEPER });
    }
  }

  // Backend shutdown: close every browser gracefully in parallel; the keepers clean up whatever is left.
  async function shutdown() {
    await Promise.all([...running.values()].map(async (entry) => {
      entry.stopping = true;
      try { await entry.cdp.send('Browser.close', {}, { timeoutMs: t.shutdownGrace }); } catch { /* keeper cleans up */ }
      await Promise.race([entry.handle.exited, sleep(t.shutdownGrace)]);
      try { entry.handle.child.stdin.end(); } catch { /* gone */ }
    }));
  }

  return {
    events,
    names,
    list: () => names().map(summary),
    summary,
    info,
    create,
    ensure,
    start: (name) => withLock(name, () => doStart(name)),
    stop: (name) => withLock(name, () => doStop(name)),
    delete: (name) => withLock(name, () => doDelete(name)),
    entry: (name) => running.get(name),
    session: (name) => running.get(name)?.session,
    boot,
    shutdown,
  };
}
