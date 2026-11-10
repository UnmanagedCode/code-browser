import { EventEmitter } from 'node:events';
import { createController } from '../../src/controller.js';
import { CodedError } from '../../src/errors.js';

// The backend's upstream CDP connection (src/cdp.js CdpConnection), scripted, for relay tests. Every command is
// recorded in `sent` as {via: 'send'|'forward', method, params, sessionId}. Answers come from `handlers[method]`
// (default: Target.attachToBrowserTarget → a fresh root id, anything else → {}); a handler returning HOLD keeps the
// command pending until `answer()` (or `drop()`).
export const HOLD = Symbol('hold');

export function fakeUpstream() {
  const cdp = new EventEmitter();
  let n = 0;
  const held = new Map(); // id → {method, onAnswer?, resolve?, signal}
  cdp.closed = false;
  cdp.sent = [];
  cdp.handlers = {};
  const answerFor = (method, params) => {
    const h = cdp.handlers[method];
    if (h) return h(params);
    if (method === 'Target.attachToBrowserTarget') return { result: { sessionId: `root-${++n}` } };
    return { result: {} };
  };

  cdp.send = (method, params = {}, { sessionId } = {}) => {
    cdp.sent.push({ via: 'send', method, params, sessionId });
    if (cdp.closed) return Promise.reject(new CodedError('CDP_CLOSED', `${method}: connection closed`));
    const a = answerFor(method, params);
    if (a === HOLD) {
      return new Promise((resolve, reject) => { held.set(++n, { method, resolve, reject }); });
    }
    return a.error ? Promise.reject(new CodedError('CDP_ERROR', a.error.message)) : Promise.resolve(a.result);
  };

  cdp.forward = (method, params, { sessionId, signal } = {}, onAnswer) => {
    cdp.sent.push({ via: 'forward', method, params, sessionId });
    if (signal?.aborted) return;
    if (cdp.closed) { onAnswer({ error: { code: -32000, message: 'CDP_CLOSED' } }); return; }
    const a = answerFor(method, params);
    const id = ++n;
    held.set(id, { method, onAnswer, signal });
    signal?.addEventListener('abort', () => held.delete(id), { once: true });
    if (a !== HOLD) queueMicrotask(() => cdp.answer(id, a));
  };

  // Answers the held command `id` (the newest held one when omitted).
  cdp.answer = (id = [...held.keys()].at(-1), a = { result: {} }) => {
    const h = held.get(id);
    if (!h) return false;
    held.delete(id);
    if (h.onAnswer) h.onAnswer(a);
    else if (a.error) h.reject(new CodedError('CDP_ERROR', a.error.message));
    else h.resolve(a.result);
    return true;
  };
  cdp.heldIds = () => [...held.keys()];
  cdp.event = (method, params = {}, sessionId) => cdp.emit('event', { method, params, sessionId });
  cdp.drop = () => {
    cdp.closed = true;
    for (const [id, h] of held) {
      held.delete(id);
      if (h.onAnswer) h.onAnswer({ error: { code: -32000, message: 'CDP_CLOSED' } });
      else h.reject(new CodedError('CDP_CLOSED', 'connection closed'));
    }
    cdp.emit('close');
  };
  cdp.of = (method) => cdp.sent.filter((m) => m.method === method);
  return cdp;
}

// A manager with running browsers over fake upstreams: what the relay reads of browserManager and browserSession.
// `backendSessions` are the page sessions the backend's own session owns.
export function fakeRelayManager(names = ['a'], { stopped = [] } = {}) {
  const entries = new Map();
  for (const name of names) {
    const events = new EventEmitter();
    const backendSessions = new Set();
    const controller = createController({ onChange: () => events.emit('change') });
    entries.set(name, { name, cdp: fakeUpstream(), session: { events, controller, ownsSession: (id) => backendSessions.has(id) }, backendSessions });
  }
  const calls = [];
  return {
    calls,
    summary(name) {
      calls.push('summary');
      if (!entries.has(name) && !stopped.includes(name)) throw new CodedError('NOT_FOUND', `no browser named '${name}'`);
      return { name };
    },
    entry(name) { calls.push('entry'); return entries.get(name); },
    get: (name) => entries.get(name),
  };
}
