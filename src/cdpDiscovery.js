import http from 'node:http';
import { CodedError } from './errors.js';
import { MAX_DISCOVERY_BYTES } from './limits.js';

const ADDRESS_RE = /^(127\.0\.0\.1|localhost):(\d{1,5})$/;
const BROWSER_PATH_RE = /^\/devtools\/browser\/([A-Za-z0-9-]{1,64})$/;
export const VIA = ['proxy', 'direct'];

// What a human typed into the attach form. Chromium's debug server listens on loopback only, so the address is
// always a loopback port: on the Docker host (through the proxy) or on the backend's own host (direct). The
// backend therefore never dials an arbitrary host.
export function parseAttachTarget(body) {
  const { address, via } = body ?? {};
  if (!VIA.includes(via)) throw new CodedError('BAD_ENDPOINT', `via must be one of ${VIA.join(', ')}`);
  const m = typeof address === 'string' ? ADDRESS_RE.exec(address.trim()) : null;
  const port = m ? Number(m[2]) : NaN;
  if (!m || port < 1 || port > 65535) {
    throw new CodedError('BAD_ENDPOINT', `address must be 127.0.0.1:<port> or localhost:<port> (Chrome's debug port listens on loopback only), got ${JSON.stringify(address)}`);
  }
  return { address: `127.0.0.1:${port}`, port, via };
}

const failed = (message) => new CodedError('ATTACH_FAILED', message);

// GET <base>/json/version (no Origin, no redirects, capped). A JSON answer names the browser WebSocket; an empty
// 404 is Chrome's approval mode (chrome://inspect/#remote-debugging), where /json* is disabled and the browser
// WebSocket path needs no id. Resolves {wsUrl, browserId, asksApproval}.
export function discover(base, { timeoutMs }) {
  const [host, port] = base.split(':');
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port: Number(port), path: '/json/version', agent: false, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_DISCOVERY_BYTES) { req.destroy(failed(`${base}/json/version answered more than ${MAX_DISCOVERY_BYTES} bytes`)); return; }
        chunks.push(c);
      });
      res.on('error', reject);
      res.on('end', () => {
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
    req.on('timeout', () => req.destroy(failed(`${base} did not answer within ${timeoutMs} ms`)));
    req.on('error', (err) => {
      reject(err instanceof CodedError ? err : failed(`nothing answers on ${base} (${err.message}): is the browser's remote debugging on, at this address?`));
    });
  });
}
