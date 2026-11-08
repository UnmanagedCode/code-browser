import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { CdpConnection } from './cdp.js';
import { attachedDir, attachedNames, parseAttachTarget, readAttached, removeAttached, writeAttached } from './attachStore.js';
import { allowsUnsandboxed, removeSettings, setAllowUnsandboxed as writeAllowUnsandboxed, settingsDir } from './browserSettings.js';
import { discover } from './cdpDiscovery.js';
import { buildArgs, isSandboxFailure } from './chromium/args.js';
import { locateChromium } from './chromium/locate.js';
import { pluginDir } from './config.js';
import { ensurePrivateDir, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from './fsPrivate.js';
import { CodedError } from './errors.js';
import { APPROVAL_TIMEOUT_MS, CDP_TIMEOUT_MS, KILL_GRACE_MS, LAUNCH_TIMEOUT_MS, LOG_SCAN_CHARS, LOG_TAIL_CHARS, NAME_RE, POLL_MS, SHUTDOWN_GRACE_MS, STOP_GRACE_MS } from './limits.js';
import { openProxied } from './proxyClient.js';
import { ensureSecret, proxyDir } from './proxyStore.js';
import { pidAlive, reap, removeRun, runNames, writeRun } from './runState.js';
import { openTunnel } from './tunnel.js';

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

// What a refused or unanswered CDP upgrade means, for a browser code-browser did not launch.
function cdpRefusal(err, asksApproval, approvalMs) {
  if (/\b403\b/.test(err.message)) {
    return new CodedError('ATTACH_FAILED', asksApproval
      ? "Chrome refused the connection: it was cancelled in Chrome's 'Allow remote debugging?' dialog (or Chrome has no open window)"
      : 'Chrome refused the CDP connection (403)');
  }
  if (/handshake has timed out/i.test(err.message)) {
    return new CodedError('ATTACH_FAILED', asksApproval
      ? `nobody allowed it in Chrome's 'Allow remote debugging?' dialog within ${Math.round(approvalMs / 1000)} s`
      : 'the browser did not accept the CDP connection in time');
  }
  return err instanceof CodedError ? err : new CodedError('ATTACH_FAILED', `could not connect to CDP: ${err.message}`);
}

// Owns the browsers: profiles on disk, the keeper+Chromium processes, one CDP connection each; and attached
// browsers (a human's own browser, attached in the panel), for which it owns only its own CDP connection and tunnel.
// Emits 'change' whenever a browser's list-visible state changes and 'started'/'exited' (entry) for sessions.
export function createBrowserManager({
  dataDir,
  locate = locateChromium,
  env = process.env,
  log = console,
  timeouts = {},
  createSession = null,
  trashFs = { readdirSync: fs.readdirSync, chmodSync: fs.chmodSync }, // seam: boot's trash walk races with deletions
  now = Date.now, // seam: the launch deadline's clock
} = {}) {
  const t = { launch: LAUNCH_TIMEOUT_MS, stopGrace: STOP_GRACE_MS, killGrace: KILL_GRACE_MS, shutdownGrace: SHUTDOWN_GRACE_MS, approval: APPROVAL_TIMEOUT_MS, ...timeouts };
  const events = new EventEmitter();
  const profilesDir = path.join(dataDir, 'profiles');
  const logsDir = path.join(dataDir, 'logs');
  const trashDir = path.join(dataDir, 'trash');
  const profileOf = (name) => path.join(profilesDir, name);
  const running = new Map();
  const lastExit = new Map();
  const refused = new Set(); // names whose last start was refused for want of a sandbox (in memory only)
  const locks = new Map();
  // Attached browsers, in memory only: connects in progress (count per name), the abort of the one running,
  // the last connect failure, and whether Chrome asked for approval last time.
  const connecting = new Map();
  const attempts = new Map();
  const attachErrors = new Map();
  const approvalSeen = new Map();
  const warned = new Set();
  const recordLog = { warn: (m) => { if (!warned.has(m)) { warned.add(m); log.warn(m); } } };
  const cancelAttempt = (name) => attempts.get(name)?.abort(new CodedError('ATTACH_FAILED', 'cancelled: the browser was disconnected, re-pointed or forgotten'));

  const profileExists = (name) => fs.statSync(profileOf(name), { throwIfNoEntry: false })?.isDirectory() === true;
  const recordOf = (name) => readAttached(dataDir, name, recordLog);
  // 'launched' (a profile code-browser runs) or 'attached' (a record of a human's browser). A name with both is
  // the profile's; boot warns about it.
  function kindOf(name) {
    assertName(name);
    if (profileExists(name)) return 'launched';
    if (recordOf(name)) return 'attached';
    throw new CodedError('NOT_FOUND', `no browser named '${name}'`);
  }
  const startRefusal = (name) => new CodedError('ATTACHED', `'${name}' is the user's own browser, attached in the panel: code-browser did not launch it, and only the user can connect it (with Connect in the panel)`);
  const sandboxRefusal = (name) => new CodedError('BAD_REQUEST', `'${name}' is an attached browser: code-browser did not launch it, so its sandbox is not code-browser's to change`);
  const requireProfile = (name) => {
    if (kindOf(name) === 'attached') throw startRefusal(name);
  };
  // An operation that applies only to launched browsers refuses an attached name at once, never queueing behind a
  // connect (which may wait minutes on Chrome's approval dialog). The locked body checks again.
  const launchedOnly = (name, refusal, fn) => (
    typeof name === 'string' && NAME_RE.test(name) && !profileExists(name) && recordOf(name) ? Promise.reject(refusal(name)) : withLock(name, fn)
  );
  const requireAttached = (name) => {
    if (kindOf(name) !== 'attached') throw new CodedError('BAD_REQUEST', `'${name}' is not an attached browser`);
    return recordOf(name);
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

  function profileNames() {
    try {
      return fs.readdirSync(profilesDir, { withFileTypes: true }).filter((d) => d.isDirectory() && NAME_RE.test(d.name)).map((d) => d.name);
    } catch { return []; }
  }

  function names() {
    return [...new Set([...profileNames(), ...attachedNames(dataDir).filter((n) => recordOf(n))])].sort();
  }

  function summary(name) {
    const kind = kindOf(name);
    const entry = running.get(name);
    const common = {
      name,
      kind,
      controller: entry?.session?.controller.kind() ?? 'agent',
      lastExit: entry ? null : lastExit.get(name) ?? null,
      cdpEndpoint: entry ? entry.cdpEndpoint : null,
    };
    if (kind === 'launched') {
      return {
        ...common,
        status: entry ? 'running' : 'stopped',
        sandbox: entry ? entry.sandbox : null,
        allowUnsandboxed: allowsUnsandboxed(dataDir, name, log),
        sandboxUnavailable: refused.has(name),
        attached: null,
        attachError: null,
      };
    }
    const rec = recordOf(name);
    return {
      ...common,
      status: entry ? 'running' : connecting.has(name) ? 'connecting' : 'stopped',
      sandbox: null,
      allowUnsandboxed: false,
      sandboxUnavailable: false,
      attached: { address: rec.address, via: rec.via, asksApproval: entry?.asksApproval ?? approvalSeen.get(name) ?? null },
      attachError: entry ? null : attachErrors.get(name) ?? null,
    };
  }

  function create(name) {
    assertName(name);
    if (recordOf(name)) throw new CodedError('EXISTS', `a browser named '${name}' already exists (an attached browser)`);
    ensurePrivateDir(dataDir);
    ensurePrivateDir(profilesDir);
    try { fs.mkdirSync(profileOf(name), { mode: PRIVATE_DIR_MODE }); } catch (err) {
      if (err.code === 'EEXIST') throw new CodedError('EXISTS', `a browser named '${name}' already exists`);
      throw err;
    }
    fs.chmodSync(profileOf(name), PRIVATE_DIR_MODE);
    removeSettings(dataDir, name); // a recreated name never inherits an earlier browser's opt-in
    refused.delete(name);
    ensurePrivateDir(path.join(profileOf(name), 'Default'));
    fs.writeFileSync(path.join(profileOf(name), 'Default', 'Preferences'), JSON.stringify(NEW_PROFILE_PREFS));
    events.emit('change');
    return { name };
  }

  // An attached name is never turned into a profile.
  function ensure(name) {
    assertName(name);
    return profileExists(name) || recordOf(name) ? { name } : create(name);
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
    const deadline = now() + t.launch;
    while (now() < deadline) {
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
      if (!allowsUnsandboxed(dataDir, name, log)) {
        refused.add(name);
        events.emit('change');
        throw new CodedError('SANDBOX_UNAVAILABLE', `Chromium has no usable sandbox on this host, and browser '${name}' is not allowed to run without one`);
      }
      log.warn(`code-browser: '${name}' has no usable Chromium sandbox; relaunching with --no-sandbox`);
      result = await launch(name, chrome, false);
    }
    if (result.failed) {
      const why = result.failed.timedOut ? `no DevToolsActivePort within ${t.launch} ms` : 'Chromium exited during launch';
      throw new CodedError('LAUNCH_FAILED', why, { logTail: result.failed.tail });
    }
    const { handle, port, wsPath, sandbox } = result;
    const browserId = wsPath.split('/').pop();
    writeRun(dataDir, name, { keeperPid: handle.child.pid, chromiumPid: handle.chromiumPid, startedAt: Date.now() });
    let cdp;
    try {
      cdp = await CdpConnection.connect(`ws://127.0.0.1:${port}${wsPath}`);
    } catch (err) {
      await killHandle(handle);
      removeRun(dataDir, name);
      throw new CodedError('LAUNCH_FAILED', `could not connect to CDP on port ${port}: ${err.message}`);
    }
    refused.delete(name);
    const entry = { name, kind: 'launched', handle, cdp, port, browserId, sandbox, cdpEndpoint: `http://127.0.0.1:${port}`, startedAt: Date.now(), stopping: false };
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

  // For an attached browser an "exit" is the loss of code-browser's own connection: only its sockets close.
  function onExit(entry, exit) {
    if (running.get(entry.name) !== entry) return;
    running.delete(entry.name);
    entry.session?.dispose();
    entry.cdp.close();
    if (entry.kind === 'attached') entry.tunnel?.close();
    else removeRun(dataDir, entry.name);
    if (!entry.stopping) {
      lastExit.set(entry.name, { code: exit?.code ?? null, signal: exit?.signal ?? null, at: Date.now() });
      log.warn(entry.kind === 'attached'
        ? `code-browser: attached browser '${entry.name}' disconnected`
        : `code-browser: '${entry.name}' exited unexpectedly (code ${exit?.code}, signal ${exit?.signal})`);
    }
    events.emit('exited', entry);
    events.emit('change');
  }

  // Summary plus the open tabs and the active one.
  function info(name) {
    const base = summary(name);
    const entry = running.get(name);
    if (!entry?.session) {
      throw new CodedError('NOT_RUNNING', base.kind === 'attached' ? `browser '${name}' is not connected` : `browser '${name}' is stopped; call start_browser first`);
    }
    return { ...base, ...entry.session.info() };
  }

  // Attach: the human names a loopback debug port and how to reach it. Validates synchronously (bad input and
  // collisions throw before anything happens), writes the record (re-pointing an attached name), then returns
  // the connect's promise.
  function attach(name, body) {
    assertName(name);
    const target = parseAttachTarget(body);
    if (profileExists(name)) throw new CodedError('EXISTS', `a browser named '${name}' already exists (a code-browser profile)`);
    for (const other of attachedNames(dataDir)) {
      const rec = other === name ? null : recordOf(other);
      if (rec && rec.via === target.via && rec.address === target.address) {
        throw new CodedError('EXISTS', `browser '${other}' is already attached to ${target.address} (${target.via})`);
      }
    }
    cancelAttempt(name);
    writeAttached(dataDir, name, { address: target.address, via: target.via });
    approvalSeen.delete(name);
    return connectNow(name, { restart: true });
  }

  function connect(name) {
    requireAttached(name);
    return connectNow(name, { restart: false });
  }

  function connectNow(name, { restart }) {
    connecting.set(name, (connecting.get(name) ?? 0) + 1);
    attachErrors.delete(name);
    events.emit('change');
    return withLock(name, async () => {
      if (restart) await doStop(name);
      await doConnect(name);
    }).finally(() => {
      const n = connecting.get(name) - 1;
      if (n > 0) connecting.set(name, n); else connecting.delete(name);
      events.emit('change');
    });
  }

  // Every phase (proxy dial, discovery, upgrade, session start) observes the attempt's abort: closing the tunnel and
  // the CDP socket ends whichever is in flight, so stop/delete/re-attach never wait one out.
  async function doConnect(name) {
    const rec = requireAttached(name);
    if (running.has(name)) return;
    const port = Number(rec.address.split(':')[1]);
    const abort = new AbortController();
    const { signal } = abort;
    attempts.set(name, abort);
    let tunnel = null;
    let cdp = null;
    let entry = null;
    const closeAll = () => {
      if (entry) entry.stopping = true;
      tunnel?.close();
      cdp?.close();
    };
    signal.addEventListener('abort', closeAll, { once: true });
    const cancelled = () => { if (signal.aborted) throw signal.reason; };
    const proxyFailure = (err) => (tunnel?.lastError ? new CodedError('ATTACH_FAILED', `through the proxy: ${tunnel.lastError.message}`) : err);
    try {
      let base = rec.address;
      if (rec.via === 'proxy') {
        tunnel = await openTunnel(() => openProxied(dataDir, port, { env, signal }));
        if (signal.aborted) tunnel.close();
        cancelled();
        base = `127.0.0.1:${tunnel.port}`;
      }
      let found;
      try {
        found = await discover(base, { timeoutMs: CDP_TIMEOUT_MS, signal });
      } catch (err) {
        cancelled();
        throw proxyFailure(err);
      }
      approvalSeen.set(name, found.asksApproval);
      events.emit('change');
      const dup = found.browserId && [...running.values()].find((e) => e.name !== name && e.browserId === found.browserId);
      if (dup) throw new CodedError('EXISTS', `that is browser '${dup.name}', already ${dup.kind === 'attached' ? 'attached' : 'run by code-browser'}`);
      try {
        cdp = await CdpConnection.connect(found.wsUrl, { timeoutMs: found.asksApproval ? t.approval : CDP_TIMEOUT_MS, signal });
      } catch (err) {
        cancelled();
        throw tunnel?.lastError ? proxyFailure(err) : cdpRefusal(err, found.asksApproval, t.approval);
      }
      if (signal.aborted) cdp.close();
      cancelled();
      entry = {
        name, kind: 'attached', via: rec.via, port, cdp, tunnel, browserId: found.browserId, asksApproval: found.asksApproval, sandbox: null,
        cdpEndpoint: found.asksApproval ? found.wsUrl : `http://${base}`, startedAt: Date.now(), stopping: false,
      };
      running.set(name, entry);
      lastExit.delete(name);
      cdp.on('close', () => onExit(entry));
      if (createSession) {
        try {
          entry.session = createSession(entry);
          await entry.session.start();
        } catch (err) {
          cancelled();
          throw new CodedError('ATTACH_FAILED', `could not start the browser session: ${err.message}`);
        }
        cancelled();
        entry.session.events.on('change', () => events.emit('change'));
      }
      signal.removeEventListener('abort', closeAll);
      events.emit('started', entry);
    } catch (err) {
      // Whatever phase failed: an entry already registered is removed (closing its socket and tunnel, not a disconnect).
      if (entry) { entry.stopping = true; onExit(entry); }
      closeAll();
      if (!signal.aborted) attachErrors.set(name, err.message);
      throw err;
    } finally {
      signal.removeEventListener('abort', closeAll);
      if (attempts.get(name) === abort) attempts.delete(name);
    }
  }

  // Disconnect or stop. An attached browser only loses code-browser's own connection and tunnel: it is never
  // sent Browser.close, and nothing of it is killed or closed.
  async function doStop(name) {
    const kind = kindOf(name);
    const entry = running.get(name);
    if (!entry) return;
    entry.stopping = true;
    if (kind === 'attached') { onExit(entry); return; }
    try { await entry.cdp.send('Browser.close', {}, { timeoutMs: Math.min(CDP_TIMEOUT_MS, t.stopGrace) }); } catch { /* the kill path below handles it */ }
    await Promise.race([entry.handle.exited, sleep(t.stopGrace)]);
    if (!entry.handle.done) await killHandle(entry.handle);
    onExit(entry, entry.handle.exit);
  }

  // Revoking consent stops a browser that runs unsandboxed now; one that runs sandboxed is untouched.
  async function doSetAllowUnsandboxed(name, allow) {
    if (kindOf(name) === 'attached') throw sandboxRefusal(name);
    writeAllowUnsandboxed(dataDir, name, allow);
    if (!allow && running.get(name)?.sandbox === false) await doStop(name);
    events.emit('change');
  }

  async function doDelete(name) {
    const kind = kindOf(name);
    await doStop(name);
    if (kind === 'attached') {
      removeAttached(dataDir, name);
      attachErrors.delete(name);
      approvalSeen.delete(name);
      lastExit.delete(name);
      events.emit('change');
      return;
    }
    removeSettings(dataDir, name); // before the rename: a crash in between keeps the profile and drops the opt-in
    refused.delete(name);
    ensurePrivateDir(trashDir);
    const dest = path.join(trashDir, `${name}-${Date.now()}`);
    fs.renameSync(profileOf(name), dest);
    lastExit.delete(name);
    fsp.rm(dest, { recursive: true, force: true }).catch((err) => log.warn(`code-browser: could not remove ${dest}: ${err.message}`));
    events.emit('change');
  }

  // Backend boot: nothing outlives the previous backend, so every leftover is killed.
  async function boot() {
    for (const dir of [dataDir, profilesDir, logsDir, path.join(dataDir, 'run'), settingsDir(dataDir), attachedDir(dataDir), proxyDir(dataDir), trashDir]) ensurePrivateDir(dir);
    for (const name of profileNames()) fs.chmodSync(profileOf(name), PRIVATE_DIR_MODE);
    for (const dir of [settingsDir(dataDir), attachedDir(dataDir)]) {
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
        try { fs.chmodSync(path.join(dir, f), PRIVATE_FILE_MODE); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      }
    }
    await ensureSecret(dataDir);
    for (const name of attachedNames(dataDir)) {
      if (profileExists(name)) log.warn(`code-browser: '${name}' is both a profile and an attached record; the profile wins`);
    }
    // An old backend's asynchronous rm of a trash entry may still be running (cc's restart overlap): an entry
    // that vanishes between the listing and the chmod is fine; any other error is not.
    for (const entry of trashFs.readdirSync(trashDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        trashFs.chmodSync(path.join(trashDir, entry.name), PRIVATE_DIR_MODE);
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      }
    }
    const all = new Set([...profileNames(), ...runNames(dataDir)]);
    for (const name of all) {
      if (NAME_RE.test(name)) await reap(dataDir, name, { profileDir: profileOf(name), keeperPath: KEEPER });
    }
  }

  // Backend shutdown: close every launched browser gracefully in parallel (the keepers clean up whatever is
  // left); for an attached browser, close only code-browser's own sockets.
  async function shutdown() {
    for (const name of attempts.keys()) cancelAttempt(name);
    await Promise.all([...running.values()].map(async (entry) => {
      entry.stopping = true;
      if (entry.kind === 'attached') { onExit(entry); return; }
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
    attach,
    connect,
    start: (name) => launchedOnly(name, startRefusal, () => doStart(name)),
    // Disconnect and Forget also cancel a connect still in progress (one waiting on Chrome's approval dialog).
    stop: (name) => { cancelAttempt(name); return withLock(name, () => doStop(name)); },
    delete: (name) => { cancelAttempt(name); return withLock(name, () => doDelete(name)); },
    setAllowUnsandboxed: (name, allow) => launchedOnly(name, sandboxRefusal, () => doSetAllowUnsandboxed(name, allow)),
    entry: (name) => running.get(name),
    session: (name) => running.get(name)?.session,
    boot,
    shutdown,
  };
}
