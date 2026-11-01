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
      if (msg.error) p.reject(new CodedError('CDP_ERROR', `${p.method}: ${msg.error.message}`));
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
      p.reject(new CodedError('CDP_CLOSED', `${p.method}: connection closed`));
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

  close() {
    this.#ws.terminate();
    this.#onClose();
  }
}
