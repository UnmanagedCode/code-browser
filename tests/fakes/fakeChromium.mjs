#!/usr/bin/env node
// A fake Chromium for tests: injected through CODE_BROWSER_CHROMIUM, launched by the real keeper.
// Parses --user-data-dir, serves a CDP subset on 127.0.0.1:0 and writes DevToolsActivePort.
// Like Chromium's devtools server: a Host that is not an IP or localhost gets 500, a WebSocket upgrade that carries
// an Origin gets 403, and /json/version names the browser WebSocket on the Host it was asked through.
// Test knobs (env): FAKE_CHROMIUM_REQUIRE_NO_SANDBOX, FAKE_CHROMIUM_NO_PORT, FAKE_CHROMIUM_IGNORE_CLOSE, and
// FAKE_CHROMIUM_APPROVAL (Chrome's own-profile approval mode: /json* is an empty 404, a page socket is 403, and a
// /devtools/browser[/<id>] upgrade is held until a test answers it: `PUT /fake/approval?answer=allow|deny`;
// `GET /fake/approval` gives {pending}).
// Test-only CDP methods (Fake.getState lists every Target.activateTarget as `activations`, and counts open CDP
// `connections`, the caller's included): Fake.crash, Fake.getRecorded, Fake.navigateTarget, Fake.emitFrame, Fake.getState, Fake.openDialog.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const profile = flag('--user-data-dir');
if (!profile) { console.error('fake chromium: no --user-data-dir'); process.exit(2); }

if (process.env.FAKE_CHROMIUM_REQUIRE_NO_SANDBOX && !args.includes('--no-sandbox')) {
  console.error('[1:1:0101/000000.000000:FATAL:zygote_host_impl_linux.cc(130)] No usable sandbox! (fake)');
  // Real Chromium follows the message with a long crash dump, which pushes it out of any log tail.
  for (let i = 0; i < 80; i++) console.error(`#${i} 0x${i.toString(16).padStart(12, '0')} (/fake/chrome+0x${(i * 4096).toString(16)})`);
  process.exit(134);
}

fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'fake-argv.json'), JSON.stringify(args));
fs.writeFileSync(path.join(profile, 'fake-pid'), String(process.pid));
for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
  if (fs.lstatSync(path.join(profile, f), { throwIfNoEntry: false })) {
    console.error(`fake chromium: stale ${f} present`);
    fs.writeFileSync(path.join(profile, 'fake-saw-stale-singleton'), f);
  }
}

const wsPath = `/devtools/browser/${randomUUID()}`;
const approval = Boolean(process.env.FAKE_CHROMIUM_APPROVAL);
const hostOk = (host) => {
  const h = (host ?? '').replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
  return h === 'localhost' || net.isIP(h) !== 0;
};
const pending = new Set(); // held approval-mode upgrades
const refuse = (socket, status, text) => socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/fake/approval') {
    if (req.method === 'PUT') {
      for (const p of pending) {
        if (url.searchParams.get('answer') === 'allow') wss.handleUpgrade(p.req, p.socket, p.head, (ws) => wss.emit('connection', ws));
        else refuse(p.socket, 403, 'Forbidden');
      }
      pending.clear();
    }
    res.end(JSON.stringify({ pending: pending.size }));
    return;
  }
  if (!hostOk(req.headers.host)) { res.statusCode = 500; res.end('Host header is specified and is not an IP address or localhost.'); return; }
  if (!approval && url.pathname === '/json/version') {
    res.end(JSON.stringify({ Browser: 'FakeChrome/1', webSocketDebuggerUrl: `ws://${req.headers.host}${wsPath}` }));
    return;
  }
  res.statusCode = 404; res.end();
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  const { pathname } = new URL(req.url, 'http://x');
  if (!hostOk(req.headers.host)) return refuse(socket, 500, 'Internal Server Error');
  if (req.headers.origin !== undefined) return refuse(socket, 403, 'Forbidden');
  if (approval) {
    if (!/^\/devtools\/browser(\/[^/]*)?$/.test(pathname)) return refuse(socket, 403, 'Forbidden');
    const p = { req, socket, head };
    pending.add(p);
    // Read (the client sends nothing before the 101), so a client that gives up is seen to go.
    const gone = () => { pending.delete(p); socket.destroy(); };
    socket.on('end', gone);
    socket.on('close', gone);
    socket.resume();
    return undefined;
  }
  if (pathname !== wsPath) return refuse(socket, 404, 'Not Found');
  return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

// --- fake browser state: page targets with navigation history, sessions, screencasts, dialogs -------------
const targets = new Map(); // targetId -> {targetId, type, url, title, history, index}
const sessions = new Map(); // sessionId -> {ws, targetId, screencast, pendingChanges, ackSeq}
const discoverers = new Set();
const recorded = [];
const activations = []; // every Target.activateTarget, in order
let activeTarget = null;
let nextTarget = 1;
let nextSession = 1;

const info = (t) => ({ targetId: t.targetId, type: t.type, url: t.url, title: t.title, attached: false });
const broadcast = (method, params) => { for (const ws of discoverers) ws.send(JSON.stringify({ method, params })); };

function newTarget(url) {
  const t = { targetId: `T${nextTarget++}`, type: 'page', url, title: '', history: [url], index: 0 };
  targets.set(t.targetId, t);
  activeTarget = t.targetId;
  broadcast('Target.targetCreated', { targetInfo: info(t) });
  return t;
}
function setUrl(t, url, { push = true } = {}) {
  if (push) { t.history = [...t.history.slice(0, t.index + 1), url]; t.index = t.history.length - 1; }
  t.url = url;
  broadcast('Target.targetInfoChanged', { targetInfo: info(t) });
  for (const [sessionId, s] of sessions) {
    if (s.targetId === t.targetId) s.ws.send(JSON.stringify({ method: 'Page.frameNavigated', params: { frame: { url } }, sessionId }));
  }
  markChange(t.targetId);
}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x32, 0x00, 0x64, 0x03, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]).toString('base64');
function emitFrame(sessionId) {
  const s = sessions.get(sessionId);
  if (!s?.screencast) return;
  s.ackSeq += 1;
  s.ws.send(JSON.stringify({ method: 'Page.screencastFrame', sessionId, params: { data: JPEG, sessionId: s.ackSeq, metadata: { deviceWidth: 100, deviceHeight: 50, offsetTop: 0, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0 } } }));
}
// Like Chromium, a frame follows an ack only when the page changed since the last one.
function markChange(targetId) {
  for (const [sessionId, s] of sessions) {
    if (s.targetId !== targetId || !s.screencast) continue;
    s.pendingChanges += 1;
    if (!s.inFlight) { s.inFlight = true; s.pendingChanges -= 1; emitFrame(sessionId); }
  }
}
newTarget('about:blank');

function handle(ws, msg) {
  const { method, params = {}, sessionId } = msg;
  const reply = (result = {}) => ws.send(JSON.stringify({ id: msg.id, sessionId, result }));
  const fail = (message) => ws.send(JSON.stringify({ id: msg.id, sessionId, error: { code: -32000, message } }));
  const sess = sessionId ? sessions.get(sessionId) : null;
  const target = sess ? targets.get(sess.targetId) : null;
  if (method.startsWith('Input.')) { recorded.push({ method, params, sessionId, targetId: sess?.targetId }); return reply(); }
  switch (method) {
    case 'Browser.close':
      reply();
      if (!process.env.FAKE_CHROMIUM_IGNORE_CLOSE) setTimeout(() => process.exit(0), 10);
      return undefined;
    case 'Fake.crash':
      process.kill(process.pid, 'SIGSEGV');
      return undefined;
    case 'Fake.getRecorded': return reply({ recorded });
    case 'Fake.navigateTarget': setUrl(targets.get(params.targetId), params.url); return reply();
    case 'Fake.emitFrame': markChange(params.targetId); return reply();
    case 'Fake.getState': return reply({ activeTarget, activations, connections: wss.clients.size, targets: [...targets.values()].map(info), sessions: [...sessions.keys()] });
    case 'Fake.openDialog': {
      for (const [sid, s] of sessions) {
        if (s.targetId === params.targetId) s.ws.send(JSON.stringify({ method: 'Page.javascriptDialogOpening', sessionId: sid, params: { url: targets.get(params.targetId).url, message: params.message, type: params.type ?? 'alert', defaultPrompt: params.defaultPrompt ?? '' } }));
      }
      return reply();
    }
    case 'Target.setDiscoverTargets':
      discoverers.add(ws);
      reply();
      for (const t of targets.values()) ws.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: info(t) } }));
      return undefined;
    case 'Target.getTargets': return reply({ targetInfos: [...targets.values()].map(info) });
    case 'Target.createTarget': return reply({ targetId: newTarget(params.url ?? 'about:blank').targetId });
    case 'Target.closeTarget':
      if (!targets.delete(params.targetId)) return fail('No target with given id');
      broadcast('Target.targetDestroyed', { targetId: params.targetId });
      return reply({ success: true });
    case 'Target.activateTarget': activeTarget = params.targetId; activations.push(params.targetId); return reply();
    case 'Target.attachToTarget': {
      if (!targets.has(params.targetId)) return fail('No target with given id');
      const id = `S${nextSession++}`;
      sessions.set(id, { ws, targetId: params.targetId, screencast: false, pendingChanges: 0, ackSeq: 0, inFlight: false });
      return reply({ sessionId: id });
    }
    case 'Page.enable': return reply();
    case 'Page.startScreencast':
      sess.screencast = true; sess.inFlight = true; sess.pendingChanges = 0;
      reply();
      emitFrame(sessionId);
      return undefined;
    case 'Page.stopScreencast': sess.screencast = false; sess.inFlight = false; return reply();
    case 'Page.screencastFrameAck':
      sess.inFlight = false;
      if (sess.pendingChanges > 0) { sess.pendingChanges = 0; sess.inFlight = true; emitFrame(sessionId); }
      return reply();
    case 'Page.navigate': setUrl(target, params.url); return reply({ frameId: target.targetId });
    case 'Page.reload': setUrl(target, target.url, { push: false }); return reply();
    case 'Page.getNavigationHistory':
      return reply({ currentIndex: target.index, entries: target.history.map((url, i) => ({ id: i, url })) });
    case 'Page.navigateToHistoryEntry':
      target.index = params.entryId;
      setUrl(target, target.history[params.entryId], { push: false });
      return reply();
    case 'Page.handleJavaScriptDialog':
      recorded.push({ method, params, sessionId });
      ws.send(JSON.stringify({ method: 'Page.javascriptDialogClosed', sessionId, params: { result: params.accept, userInput: params.promptText ?? '' } }));
      return reply();
    default:
      return reply();
  }
}
wss.on('connection', (ws) => {
  ws.on('message', (d) => handle(ws, JSON.parse(d.toString())));
  ws.on('close', () => {
    discoverers.delete(ws);
    for (const [id, s] of sessions) if (s.ws === ws) sessions.delete(id);
  });
});

server.listen(0, '127.0.0.1', () => {
  if (process.env.FAKE_CHROMIUM_NO_PORT) return;
  fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), `${server.address().port}\n${wsPath}\n`);
});
