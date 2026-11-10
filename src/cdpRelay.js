import http from 'node:http';
import { WebSocketServer } from 'ws';
import { assertName } from './browserManager.js';
import { CodedError, statusFor } from './errors.js';
import { parsePathname } from './http.js';
import { CDP_MAX_PAYLOAD, CDP_TIMEOUT_MS, RELAY_HIGH_WATER, RELAY_MAX_CLIENTS, RELAY_PING_MS } from './limits.js';
import { checkBearer } from './relayToken.js';
import { commandVerdict, eventForClient, ownershipChange, parseClientMessage, replyForClient, sessionFromResult } from './relayRoutes.js';

export const RELAY_PREFIX = '/api/relay/';
export const relayUrl = (port, name) => `ws://127.0.0.1:${port}${RELAY_PREFIX}${name}`;

// Close codes a relay client sees (docs/protocol.md → CDP relay).
export const CLOSE_CONTROLLED = 4001;
export const CLOSE_UPSTREAM = 4002;
const CLOSE_SLOW = 1008;
const CLOSE_SHUTDOWN = 1001;
const CLOSE_GONE = 1006;

// How many detached session ids a browser remembers, so their late events are not counted as unknown.
const RELEASED_MEMORY = 256;

// Also the close reason a dropped client sees, which must fit 123 bytes with the longest name.
const controlledMessage = (name) => `BROWSER_CONTROLLED: a person controls '${name}' in the panel; retry after they release it`;
// A WebSocket close reason is at most 123 bytes.
const closeReason = (text) => Buffer.from(text).subarray(0, 123).toString('utf8').replace(/�$/, '');

// The CDP relay: helper programs speak CDP to ws://127.0.0.1:<port>/api/relay/<name> and the relay carries it over
// the backend's own connection to that browser (`entry.cdp`), so an attached Chrome in approval mode asks nothing
// more after the person's Connect. Each client gets its own browser-target session (Target.attachToBrowserTarget),
// a virtual root: auto-attach, discovery and every session it opens are its own, and detaching that root when the
// client leaves takes all of its state out of Chrome. The relay enforces the controller: while a person holds
// control a connect is refused, and taking control drops every client of that browser.
//
// `handleUpgrade` runs after app.js has applied the relay's request guard (relayRefusal).
export function createCdpRelay({
  manager, token, log = console,
  pingMs = RELAY_PING_MS, maxClients = RELAY_MAX_CLIENTS, highWater = RELAY_HIGH_WATER, maxPayload = CDP_MAX_PAYLOAD,
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false });
  const hubs = new Map(); // entry → the relay's state for that running browser
  const clients = new Set();
  let unknownDropped = 0;
  let nextClientId = 0;
  let closing = false;

  // ---- per-browser state: who owns which upstream session ----

  function hubFor(entry) {
    let hub = hubs.get(entry);
    if (hub) return hub;
    hub = { entry, clients: new Set(), pending: 0, owners: new Map(), released: new Set() };
    hub.onEvent = (ev) => routeEvent(hub, ev);
    hub.onClose = () => { for (const c of [...hub.clients]) failClient(c, CLOSE_UPSTREAM, 'CDP_CLOSED: the browser stopped or disconnected'); };
    hub.onChange = () => {
      if (entry.session.controller.kind() !== 'human') return;
      for (const c of [...hub.clients]) failClient(c, CLOSE_CONTROLLED, controlledMessage(entry.name));
    };
    entry.cdp.on('event', hub.onEvent);
    entry.cdp.on('close', hub.onClose);
    entry.session.events.on('change', hub.onChange);
    hubs.set(entry, hub);
    return hub;
  }

  function maybeDropHub(hub) {
    if (hub.clients.size > 0 || hub.pending > 0 || hubs.get(hub.entry) !== hub) return;
    hub.entry.cdp.off('event', hub.onEvent);
    hub.entry.cdp.off('close', hub.onClose);
    hub.entry.session.events.off('change', hub.onChange);
    hubs.delete(hub.entry);
  }

  function register(hub, client, sessionId, parent) {
    if (hub.owners.has(sessionId)) return;
    hub.owners.set(sessionId, client);
    client.owned.set(sessionId, parent);
  }

  function release(hub, client, sessionId) {
    if (hub.owners.get(sessionId) !== client) return;
    hub.owners.delete(sessionId);
    client.owned.delete(sessionId);
    hub.released.add(sessionId);
    if (hub.released.size > RELEASED_MEMORY) hub.released.delete(hub.released.values().next().value);
  }

  // Events on a client's root or children go to that client; events with no session (the backend's root) and on the
  // backend's own page sessions go to nobody. Anything else is unknown: dropped and counted.
  function routeEvent(hub, ev) {
    if (ev.sessionId === undefined) return;
    const owner = hub.owners.get(ev.sessionId);
    if (!owner) {
      if (!hub.released.has(ev.sessionId) && !hub.entry.session.ownsSession(ev.sessionId)) unknownDropped += 1;
      return;
    }
    const change = ownershipChange(ev);
    if (change?.register) register(hub, owner, change.register, ev.sessionId);
    deliver(owner, eventForClient(ev, owner.root));
    if (change?.unregister) release(hub, owner, change.unregister);
  }

  // ---- clients ----

  function deliver(client, obj) {
    if (client.closed || client.ws.readyState !== 1) return;
    if (client.ws.bufferedAmount > highWater) {
      failClient(client, CLOSE_SLOW, 'RELAY_SLOW: the client left too much unread');
      return;
    }
    client.ws.send(JSON.stringify(obj));
  }

  // The only teardown path, idempotent: the socket closes with `code` and `message` as its reason, pending upstream
  // calls are dropped, and the client's sessions are detached, children before their parents and the root last.
  // The browser itself is never closed. In-flight commands get no error reply of their own: Playwright rejects them
  // with the close reason appended, whereas it rewrites an error reply to `evaluate` as a navigation and loses it.
  function failClient(client, code, message) {
    if (client.closed) return;
    client.closed = true;
    const { hub, ws } = client;
    clients.delete(client);
    hub.clients.delete(client);
    if (ws.readyState === 1) ws.close(code, closeReason(message));
    client.abort.abort(new CodedError('RELAY_CLOSED', message));
    const cdp = hub.entry.cdp;
    for (const [sessionId, parent] of [...client.owned].reverse()) {
      release(hub, client, sessionId);
      cdp.send('Target.detachFromTarget', { sessionId }, { sessionId: parent }).catch(() => {});
    }
    release(hub, client, client.root);
    cdp.send('Target.detachFromTarget', { sessionId: client.root }).catch(() => {});
    maybeDropHub(hub);
  }

  function onMessage(client, data, isBinary) {
    if (client.closed) return;
    const parsed = parseClientMessage(data, isBinary);
    if (parsed.close) { failClient(client, parsed.close, parsed.reason); return; }
    const { msg } = parsed;
    const verdict = commandVerdict(msg, { root: client.root, owns: (s) => client.owned.has(s) });
    if (verdict.error) { deliver(client, replyForClient(msg.id, msg.sessionId, { error: verdict.error })); return; }
    const { hub } = client;
    hub.entry.cdp.forward(msg.method, msg.params ?? {}, { sessionId: verdict.sessionId, signal: client.abort.signal }, (answer) => {
      if (client.closed) return;
      const child = answer.result ? sessionFromResult(msg.method, answer.result) : null;
      if (child) register(hub, client, child, verdict.sessionId);
      deliver(client, replyForClient(msg.id, msg.sessionId, answer));
    });
  }

  function onConnection(ws, hub, root) {
    const client = { id: ++nextClientId, ws, hub, root, owned: new Map(), abort: new AbortController(), closed: false, alive: true };
    clients.add(client);
    hub.clients.add(client);
    hub.owners.set(root, client);
    ws.on('pong', () => { client.alive = true; });
    ws.on('message', (data, isBinary) => onMessage(client, data, isBinary));
    ws.on('error', () => {});
    ws.on('close', () => failClient(client, CLOSE_GONE, 'RELAY_CLOSED: the client went away'));
  }

  // A refusal names its code in a text/plain body, which Playwright appends to the error it throws.
  function refuse(socket, err) {
    if (!(err instanceof CodedError)) log.error('code-browser: relay upgrade failed:', err);
    if (!socket.writable) { socket.destroy(); return; }
    const status = statusFor(err);
    const body = `${err.code ?? 'INTERNAL'}: ${err.message}`;
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  function nameOf(url) {
    const m = /^\/api\/relay\/([^/]+)$/.exec(parsePathname(url) ?? '');
    if (!m) throw new CodedError('NOT_FOUND', 'no such relay path; use /api/relay/<browser name>');
    let name;
    try { name = decodeURIComponent(m[1]); } catch { throw new CodedError('INVALID_NAME', 'the browser name is not valid percent-encoding'); }
    return assertName(name);
  }

  const isControlled = (entry) => entry.session.controller.kind() === 'human';

  // Check order: token (401) → name (400/404) → running (409) → controller (409) → cap (503) → attach a root →
  // controller again (a take during the attach) → upgrade. No client message can arrive before its root exists.
  async function upgrade(req, socket, head) {
    if (!checkBearer(req.headers, token)) throw new CodedError('UNAUTHORIZED', 'the relay needs Authorization: Bearer <the token in the file browser_info names>');
    if (closing) throw new CodedError('NOT_RUNNING', 'code-browser is shutting down');
    const name = nameOf(req.url);
    manager.summary(name); // NOT_FOUND for a name with no browser
    const entry = manager.entry(name);
    if (!entry?.session) throw new CodedError('NOT_RUNNING', `browser '${name}' is not running`);
    if (isControlled(entry)) throw new CodedError('BROWSER_CONTROLLED', controlledMessage(name).replace(/^BROWSER_CONTROLLED: /, ''));
    const hub = hubFor(entry);
    if (hub.clients.size + hub.pending >= maxClients) {
      maybeDropHub(hub);
      throw new CodedError('RELAY_FULL', `browser '${name}' already has ${maxClients} relay clients`);
    }
    hub.pending += 1;
    let root;
    try {
      ({ sessionId: root } = await entry.cdp.send('Target.attachToBrowserTarget', {}, { timeoutMs: CDP_TIMEOUT_MS }));
    } catch (err) {
      throw err.code === 'CDP_CLOSED' ? new CodedError('NOT_RUNNING', `browser '${name}' stopped`) : err;
    } finally {
      hub.pending -= 1;
      maybeDropHub(hub);
    }
    const abandon = (err) => {
      entry.cdp.send('Target.detachFromTarget', { sessionId: root }).catch(() => {});
      throw err;
    };
    if (closing || entry.cdp.closed || manager.entry(name) !== entry) abandon(new CodedError('NOT_RUNNING', `browser '${name}' stopped`));
    if (isControlled(entry)) abandon(new CodedError('BROWSER_CONTROLLED', controlledMessage(name).replace(/^BROWSER_CONTROLLED: /, '')));
    if (socket.destroyed) abandon(new CodedError('RELAY_CLOSED', 'the client went away during the upgrade'));
    const live = hubFor(entry);
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, live, root));
  }

  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
  }, pingMs);
  heartbeat.unref();

  return {
    handleUpgrade(req, socket, head) {
      upgrade(req, socket, head).catch((err) => refuse(socket, err));
    },
    // Test observability: open clients, and events dropped for a session nobody owns.
    stats: () => ({ clients: clients.size, unknownDropped }),
    close() {
      closing = true;
      clearInterval(heartbeat);
      for (const c of [...clients]) failClient(c, CLOSE_SHUTDOWN, 'RELAY_CLOSED: code-browser is shutting down');
      for (const hub of [...hubs.values()]) { hub.pending = 0; maybeDropHub(hub); }
    },
  };
}
