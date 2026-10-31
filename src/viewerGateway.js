import { WebSocketServer } from 'ws';
import { assertName } from './browserManager.js';
import { CodedError } from './errors.js';
import { MAX_FRAME_DIM, WS_MAX_PAYLOAD } from './limits.js';
import { parsePathname } from './http.js';
import { requestRefusal } from './requestGuard.js';

const VIEWER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const WS_PATH = '/api/ws';
const PING_MS = 20_000;

// The envelope's `type` is the message tag, so the dialog's own kind travels as `dialogType`.
const dialogMsg = ({ tabId, type, message, defaultPrompt }) => ({ type: 'dialog', tabId, dialogType: type, message, defaultPrompt });

const dim = (v) => (Number.isFinite(v) ? Math.min(MAX_FRAME_DIM, Math.max(0, Math.round(v))) : 0);

// The panel's WebSocket. Everything a human can do to a browser goes through here, and every action
// except watching and switching the viewed tab requires the sender to hold control of that browser.
export function createViewerGateway({ manager, log = console, pingMs = PING_MS }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false });
  const conns = new Set();
  const socketsOf = new Map(); // viewerId -> open socket count
  let nextConnId = 0;

  const send = (conn, obj) => { if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(obj)); };

  function sendIfChanged(conn, key, obj) {
    const json = JSON.stringify(obj);
    if (conn.last[key] === json) return;
    conn.last[key] = json;
    if (conn.ws.readyState === 1) conn.ws.send(json);
  }

  const stateFor = (conn) => {
    const s = conn.session.snapshot();
    const holder = conn.session.controller.holder();
    return {
      type: 'state', ...s,
      controller: holder ? { kind: 'human', you: holder === conn.viewerId } : { kind: 'agent' },
    };
  };

  function leave(conn) {
    if (!conn.session) return;
    conn.session.screencast.removeViewer(conn.id);
    for (const [event, fn] of conn.handlers) conn.session.events.off(event, fn);
    conn.handlers = [];
    conn.session = null;
    conn.name = null;
    delete conn.last.state;
  }

  function join(conn, name, maxWidth, maxHeight) {
    leave(conn);
    const session = manager.session(assertName(name));
    if (!session) throw new CodedError('NOT_RUNNING', `browser '${name}' is not running`);
    conn.session = session;
    conn.name = name;
    conn.handlers = [
      ['change', () => sendIfChanged(conn, 'state', stateFor(conn))],
      ['dialog', (d) => send(conn, dialogMsg(d))],
      ['dialogClosed', (d) => send(conn, { type: 'dialogClosed', ...d })],
    ];
    for (const [event, fn] of conn.handlers) session.events.on(event, fn);
    sendIfChanged(conn, 'state', stateFor(conn));
    for (const d of session.pendingDialogs()) send(conn, dialogMsg(d));
    session.screencast.addViewer(conn.id, {
      send: (buf) => conn.ws.send(buf, { binary: true }),
      bufferedAmount: () => conn.ws.bufferedAmount,
      maxWidth, maxHeight,
    });
  }

  function requireControl(conn) {
    if (!conn.session) throw new CodedError('NOT_VIEWING', 'not viewing a browser');
    if (!conn.session.controller.isHolder(conn.viewerId)) throw new CodedError('NOT_CONTROLLER', 'take control first');
    return conn.session;
  }

  const sessions = () => manager.list().filter((b) => b.status === 'running').map((b) => manager.session(b.name)).filter(Boolean);

  const handlers = {
    hello(conn, msg) {
      if (conn.viewerId) throw new CodedError('BAD_REQUEST', 'already said hello');
      if (typeof msg.viewerId !== 'string' || !VIEWER_ID_RE.test(msg.viewerId)) throw new CodedError('BAD_REQUEST', 'invalid viewerId');
      conn.viewerId = msg.viewerId;
      const n = (socketsOf.get(conn.viewerId) ?? 0) + 1;
      socketsOf.set(conn.viewerId, n);
      if (n === 1) for (const s of sessions()) s.controller.viewerBack(conn.viewerId);
      sendIfChanged(conn, 'browsers', { type: 'browsers', list: manager.list() });
    },
    view(conn, msg) {
      if (msg.name === null) { leave(conn); return; }
      join(conn, msg.name, dim(msg.maxWidth), dim(msg.maxHeight));
    },
    viewport(conn, msg) {
      conn.session?.screencast.updateViewer(conn.id, { maxWidth: dim(msg.maxWidth), maxHeight: dim(msg.maxHeight) });
    },
    ack(conn) { conn.session?.screencast.viewerAck(conn.id); },
    control(conn, msg) {
      if (!conn.session) throw new CodedError('NOT_VIEWING', 'not viewing a browser');
      if (msg.action === 'take') conn.session.controller.take(conn.viewerId);
      else if (msg.action === 'release') {
        if (!conn.session.controller.release(conn.viewerId)) throw new CodedError('NOT_CONTROLLER', 'you do not hold control');
      } else throw new CodedError('BAD_REQUEST', 'control action must be take or release');
    },
    async tab(conn, msg) {
      if (msg.action === 'activate') {
        if (!conn.session) throw new CodedError('NOT_VIEWING', 'not viewing a browser');
        conn.session.activateTab(msg.tabId);
        return;
      }
      const session = requireControl(conn);
      if (msg.action === 'new') await session.newTab();
      else if (msg.action === 'close') await session.closeTab(msg.tabId);
      else throw new CodedError('BAD_REQUEST', 'tab action must be activate, new or close');
    },
    async nav(conn, msg) { await requireControl(conn).navigate(msg.action, msg.url); },
    async input(conn, msg) { await requireControl(conn).input(msg); },
    async dialog(conn, msg) { await requireControl(conn).answerDialog(msg.tabId, msg.action, msg.promptText); },
  };

  async function onMessage(conn, data, isBinary) {
    try {
      if (isBinary) throw new CodedError('BAD_REQUEST', 'binary messages are not accepted');
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { throw new CodedError('BAD_REQUEST', 'message is not JSON'); }
      if (typeof msg !== 'object' || msg === null || !Object.hasOwn(handlers, msg.msg)) throw new CodedError('BAD_REQUEST', 'unknown message');
      if (!conn.viewerId && msg.msg !== 'hello') throw new CodedError('BAD_REQUEST', 'say hello first');
      await handlers[msg.msg](conn, msg);
    } catch (err) {
      if (!(err instanceof CodedError)) log.error('code-browser: viewer message failed:', err);
      send(conn, { type: 'error', code: err.code ?? 'INTERNAL', message: err.message });
    }
  }

  function onConnection(ws) {
    const conn = { id: ++nextConnId, ws, viewerId: null, name: null, session: null, handlers: [], last: {}, alive: true };
    conns.add(conn);
    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (data, isBinary) => { onMessage(conn, data, isBinary); });
    ws.on('error', () => {});
    ws.on('close', () => {
      conns.delete(conn);
      leave(conn);
      if (!conn.viewerId) return;
      const n = socketsOf.get(conn.viewerId) - 1;
      if (n > 0) { socketsOf.set(conn.viewerId, n); return; }
      socketsOf.delete(conn.viewerId);
      for (const s of sessions()) s.controller.viewerGone(conn.viewerId);
    });
  }

  const onManagerChange = () => {
    for (const c of conns) if (c.viewerId) sendIfChanged(c, 'browsers', { type: 'browsers', list: manager.list() });
  };
  // A browser that stops takes its viewers' session away; they see it as stopped.
  const onExited = (entry) => {
    for (const c of conns) {
      if (c.name !== entry.name) continue;
      leave(c);
      send(c, { type: 'state', name: entry.name, status: 'stopped' });
    }
  };
  manager.events.on('change', onManagerChange);
  manager.events.on('exited', onExited);

  const heartbeat = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
  }, pingMs);
  heartbeat.unref();

  return {
    // `req`, `socket`, `head` from the HTTP server's 'upgrade' event.
    handleUpgrade(req, socket, head) {
      const refuse = (status, text) => {
        socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      };
      if (parsePathname(req.url) !== WS_PATH) return refuse(404, 'Not Found');
      if (requestRefusal(req.headers, { requireOrigin: true })) return refuse(403, 'Forbidden');
      wss.handleUpgrade(req, socket, head, onConnection);
    },
    close() {
      clearInterval(heartbeat);
      manager.events.off('change', onManagerChange);
      manager.events.off('exited', onExited);
      for (const c of conns) c.ws.terminate();
    },
  };
}
