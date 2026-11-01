import http from 'node:http';
import { CodedError } from './errors.js';
import { MAX_DISCOVERY_BYTES } from './limits.js';

const BROWSER_PATH_RE = /^\/devtools\/browser\/([A-Za-z0-9-]{1,64})$/;

const failed = (message) => new CodedError('ATTACH_FAILED', message);

// GET <base>/json/version (no Origin, no redirects, capped). A JSON answer names the browser WebSocket; an empty
// 404 is Chrome's approval mode (chrome://inspect/#remote-debugging), where /json* is disabled and the browser
// WebSocket path needs no id. Resolves {wsUrl, browserId, asksApproval}. `timeoutMs` bounds the whole exchange, a
// slow trickle included; `signal` aborts it.
//
// It settles exactly once, whatever ends the exchange: the answer's end, an error, a close before the end (a
// truncated answer emits no request 'error'), the deadline or the abort. The last two settle the promise themselves:
// the request they destroy may already be closed and emit nothing.
export function discover(base, { timeoutMs, signal }) {
  const [host, port] = base.split(':');
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    let req = null;
    let done = false;
    const finish = (settleWith, value) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      req?.destroy();
      settleWith(value);
    };
    const fail = (err) => finish(reject, err);
    const unreachable = (why) => fail(failed(`nothing answers on ${base} (${why}): is the browser's remote debugging on, at this address?`));
    const deadline = setTimeout(() => fail(failed(`${base} did not answer within ${timeoutMs} ms`)), timeoutMs);
    const onAbort = () => fail(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });

    req = http.get({ host, port: Number(port), path: '/json/version', agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_DISCOVERY_BYTES) fail(failed(`${base}/json/version answered more than ${MAX_DISCOVERY_BYTES} bytes`));
        else chunks.push(c);
      });
      res.on('error', () => {}); // a cut-off answer: 'close' below settles it
      res.on('close', () => { if (!res.complete) fail(failed(`${base}/json/version was cut off before its end`)); });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 404 && body === '') {
          finish(resolve, { wsUrl: `ws://${base}/devtools/browser`, browserId: null, asksApproval: true });
          return;
        }
        if (res.statusCode !== 200) {
          fail(failed(`${base}/json/version answered ${res.statusCode}: this does not look like a Chrome remote-debugging port`));
          return;
        }
        let ws;
        try { ws = new URL(JSON.parse(body).webSocketDebuggerUrl); } catch { ws = null; }
        const id = ws && ws.protocol === 'ws:' && ws.host === base ? BROWSER_PATH_RE.exec(ws.pathname)?.[1] : null;
        if (!id) fail(failed(`${base}/json/version names no browser WebSocket on ${base}`));
        else finish(resolve, { wsUrl: `ws://${base}/devtools/browser/${id}`, browserId: id, asksApproval: false });
      });
    });
    req.on('error', (err) => unreachable(err.message));
    req.on('close', () => unreachable('the connection closed without an answer')); // a no-op once settled
  });
}
