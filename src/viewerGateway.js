import { WebSocketServer } from 'ws';
import { assertName } from './browserManager.js';
import { CodedError, describeError, detailsOf } from './errors.js';
import { MAX_FRAME_DIM, WS_MAX_PAYLOAD } from './limits.js';
import { parsePathname } from './http.js';

const VIEWER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const WS_PATH = '/api/ws';
const PING_MS = 20_000;

// The envelope's `type` is the message tag, so the dialog's own kind travels as `dialogType`.
const dialogMsg = ({ tabId, type, message, defaultPrompt }) => ({ type: 'dialog', tabId, dialogType: type, message, defaultPrompt });

const clean = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
// A requested size, scaled down as a whole when it exceeds MAX_FRAME_DIM so the panel's aspect survives.
const fitDims = (w, h) => {
  const [cw, ch] = [clean(w), clean(h)];
  const k = Math.max(cw, ch) > MAX_FRAME_DIM ? MAX_FRAME_DIM / Math.max(cw, ch) : 1;
  return { maxWidth: Math.round(cw * k), maxHeight: Math.round(ch * k) };
};

// The panel's WebSocket. Everything a human can do to a browser goes through here, and every action
// except watching and switching the viewed tab requires the sender to hold control of that browser.
export function createViewerGateway({ manager, log = console, pingMs = PING_MS }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false });
  const conns = new Set();
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

  // The holder keeps control while at least one of its sockets views the browser; otherwise its lease runs.
  function refreshHolder(session) {
    const holder = session.controller.holder();
    if (!holder) return;
    const viewing = [...conns].some((c) => c.viewerId === holder && c.session === session);
    if (viewing) session.controller.viewerBack(holder); else session.controller.viewerGone(holder);
  }

  function leave(conn) {
    const session = conn.session;
    if (!session) return;
    session.screencast.removeViewer(conn.id);
    for (const [event, fn] of conn.handlers) session.events.off(event, fn);
    conn.handlers = [];
    conn.session = null;
    conn.name = null;
    delete conn.last.state;
    refreshHolder(session);
  }

  function join(conn, name, { maxWidth, maxHeight }) {
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
    refreshHolder(session);
  }

  function requireControl(conn) {
    if (!conn.session) throw new CodedError('NOT_VIEWING', 'not viewing a browser');
    if (!conn.session.controller.isHolder(conn.viewerId)) throw new CodedError('NOT_CONTROLLER', 'take control first');
    return conn.session;
  }

  const handlers = {
    hello(conn, msg) {
      if (conn.viewerId) throw new CodedError('BAD_REQUEST', 'already said hello');
      if (typeof msg.viewerId !== 'string' || !VIEWER_ID_RE.test(msg.viewerId)) throw new CodedError('BAD_REQUEST', 'invalid viewerId');
      conn.viewerId = msg.viewerId;
      sendIfChanged(conn, 'browsers', { type: 'browsers', list: manager.list() });
    },
    view(conn, msg) {
      if (msg.name === null) { leave(conn); return; }
      join(conn, msg.name, fitDims(msg.maxWidth, msg.maxHeight));
    },
    viewport(conn, msg) {
      conn.session?.screencast.updateViewer(conn.id, fitDims(msg.maxWidth, msg.maxHeight));
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
      send(conn, { type: 'error', code: err.code ?? 'INTERNAL', message: describeError(err), ...detailsOf(err) });
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
    // `req`, `socket`, `head` from the HTTP server's 'upgrade' event, after app.js has applied the request guard.
    handleUpgrade(req, socket, head) {
      const refuse = (status, text) => {
        socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      };
      if (parsePathname(req.url) !== WS_PATH) return refuse(404, 'Not Found');
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
