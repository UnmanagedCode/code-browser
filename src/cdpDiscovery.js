import http from 'node:http';
import { CodedError } from './errors.js';
import { MAX_DISCOVERY_BYTES } from './limits.js';

const BROWSER_PATH_RE = /^\/devtools\/browser\/([A-Za-z0-9-]{1,64})$/;

const failed = (message) => new CodedError('ATTACH_FAILED', message);

// GET <base>/json/version (no Origin, no redirects, capped). A JSON answer names the browser WebSocket; an empty
// 404 is Chrome's approval mode (chrome://inspect/#remote-debugging), where /json* is disabled and the browser
// WebSocket path needs no id. Resolves {wsUrl, browserId, asksApproval}. `timeoutMs` bounds the whole exchange, a
// slow trickle included; `signal` aborts it.
export function discover(base, { timeoutMs, signal }) {
  const [host, port] = base.split(':');
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const req = http.get({ host, port: Number(port), path: '/json/version', agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_DISCOVERY_BYTES) { req.destroy(failed(`${base}/json/version answered more than ${MAX_DISCOVERY_BYTES} bytes`)); return; }
        chunks.push(c);
      });
      res.on('error', () => {}); // the request reports it
      res.on('end', () => {
        settle();
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 404 && body === '') {
          resolve({ wsUrl: `ws://${base}/devtools/browser`, browserId: null, asksApproval: true });
          return;
        }
        if (res.statusCode !== 200) {
          reject(failed(`${base}/json/version answered ${res.statusCode}: this does not look like a Chrome remote-debugging port`));
          return;
        }
        let ws;
        try { ws = new URL(JSON.parse(body).webSocketDebuggerUrl); } catch { ws = null; }
        const id = ws && ws.protocol === 'ws:' && ws.host === base ? BROWSER_PATH_RE.exec(ws.pathname)?.[1] : null;
        if (!id) {
          reject(failed(`${base}/json/version names no browser WebSocket on ${base}`));
          return;
        }
        resolve({ wsUrl: `ws://${base}/devtools/browser/${id}`, browserId: id, asksApproval: false });
      });
    });
    const deadline = setTimeout(() => req.destroy(failed(`${base} did not answer within ${timeoutMs} ms`)), timeoutMs);
    const onAbort = () => req.destroy(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const settle = () => { clearTimeout(deadline); signal?.removeEventListener('abort', onAbort); };
    req.on('error', (err) => {
      settle();
      if (signal?.aborted) reject(signal.reason);
      else reject(err instanceof CodedError ? err : failed(`nothing answers on ${base} (${err.message}): is the browser's remote debugging on, at this address?`));
    });
  });
}
