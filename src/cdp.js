import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { CodedError } from './errors.js';
import { CDP_MAX_PAYLOAD, CDP_TIMEOUT_MS } from './limits.js';

// Minimal CDP client over `ws`. Sends no Origin (Chromium refuses CDP sockets that carry one).
// Events: 'event' ({method, params, sessionId}) and 'close'.
export class CdpConnection extends EventEmitter {
  #ws;
  #nextId = 0;
  #pending = new Map();
  closed = false;

  // `signal` aborts a connection still in its opening handshake (one waiting on Chrome's approval dialog).
  static connect(url, { timeoutMs = CDP_TIMEOUT_MS, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const ws = new WebSocket(url, { maxPayload: CDP_MAX_PAYLOAD, perMessageDeflate: false, handshakeTimeout: timeoutMs });
      const onAbort = () => { ws.removeAllListeners('error'); ws.on('error', () => {}); ws.terminate(); reject(signal.reason); };
      signal?.addEventListener('abort', onAbort, { once: true });
      ws.once('error', (err) => { signal?.removeEventListener('abort', onAbort); reject(err); });
      ws.once('open', () => {
        signal?.removeEventListener('abort', onAbort);
        ws.removeAllListeners('error');
        resolve(new CdpConnection(ws));
      });
    });
  }

  constructor(ws) {
    super();
    this.#ws = ws;
    ws.on('message', (data) => this.#onMessage(data));
    ws.on('error', () => {});
    ws.on('close', () => this.#onClose());
  }

  #onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      p.signal?.removeEventListener('abort', p.onAbort);
      if (p.onAnswer) p.onAnswer(msg.error ? { error: msg.error } : { result: msg.result ?? {} });
      else if (msg.error) p.reject(new CodedError('CDP_ERROR', `${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result ?? {});
    } else if (msg.method) {
      this.emit('event', { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId });
    }
  }

  #onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.signal?.removeEventListener('abort', p.onAbort);
      if (!p.onAnswer) p.reject(new CodedError('CDP_CLOSED', `${p.method}: connection closed`));
    }
    this.#pending.clear();
    this.emit('close');
  }

  send(method, params = {}, { sessionId, timeoutMs = CDP_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new CodedError('CDP_CLOSED', `${method}: connection closed`));
      const id = ++this.#nextId;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CodedError('CDP_TIMEOUT', `${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      this.#ws.send(JSON.stringify({ id, method, params, sessionId }), (err) => {
        if (!err) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new CodedError('CDP_CLOSED', `${method}: ${err.message}`));
      });
    });
  }

  // A command forwarded on someone else's behalf (the CDP relay). `onAnswer` receives the raw answer, `{result}` or
  // `{error: {code, message, data}}`, synchronously as it arrives, so answers and events keep the order Chromium sent
  // them in (a promise would deliver an answer after the events of the same read: Playwright then drops an
  // execution context for a frame it does not know yet). No timeout of its own. Only the browser answers: when `signal`
  // aborts, or the connection is or becomes closed, the command is dropped and `onAnswer` is never called. The caller
  // learns of a close from the 'close' event (the relay ends its client with the close reason, which Playwright reports;
  // a per-command error answer it would rewrite as a navigation).
  forward(method, params, { sessionId, signal } = {}, onAnswer) {
    if (signal?.aborted || this.closed) return;
    const id = ++this.#nextId;
    const onAbort = () => { this.#pending.delete(id); };
    signal?.addEventListener('abort', onAbort, { once: true });
    this.#pending.set(id, { method, onAnswer, signal, onAbort });
    this.#ws.send(JSON.stringify({ id, method, params, sessionId }), (err) => {
      if (!err || !this.#pending.has(id)) return;
      this.#pending.delete(id);
      signal?.removeEventListener('abort', onAbort);
    });
  }

  // How many commands await an answer (tests observe that an abort leaves none behind).
  get pendingCount() { return this.#pending.size; }

  close() {
    this.#ws.terminate();
    this.#onClose();
  }
}
