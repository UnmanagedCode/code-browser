import http from 'node:http';
import { CodedError, describeError, detailsOf, statusFor } from './errors.js';
import { parsePathname, readBytesBody, readJsonBody, requireJson, requireOctetStream, sendJson, serveStatic } from './http.js';
import { RELAY_PREFIX } from './cdpRelay.js';
import { relayRefusal, requestRefusal } from './requestGuard.js';
import { checkBearer } from './relayToken.js';
import { buildRoutes } from './routes.js';

// The HTTP server. Check order for every request: Origin/Host (403) → route (404/405)
// → panel-only route without an Origin (403) → token route without the bearer token (401) → content type (415)
// → body (413) → handler. No handler runs before the guards pass.
// Health is a constant answer and skips the loopback-Host rule (docs/protocol.md → Request guard).
// `token` is the relay token (relayToken.js); with none, every token route answers 401.
export function createApp({ manager, mcp, installer, distDir, dataDir, token, onUpgrade, onRelayUpgrade }) {
  const routes = buildRoutes({ manager, mcp, installer, dataDir });
  const listenPort = () => server.address()?.port;

  async function dispatch(req, res) {
    const pathname = parsePathname(req.url);
    const refusal = requestRefusal(req.headers, { listenPort: pathname === '/api/health' ? undefined : listenPort() });
    if (refusal) return sendJson(res, 403, { error: `FORBIDDEN: ${refusal}` });
    if (pathname === null) return sendJson(res, 400, { error: 'BAD_REQUEST: malformed request target' });
    if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(res, distDir, pathname);
    let allowed = false;
    for (const route of routes) {
      const m = route.path.exec(pathname);
      if (!m) continue;
      allowed = true;
      if (route.method !== req.method) continue;
      if (route.requireOrigin && req.headers.origin === undefined) {
        return sendJson(res, 403, { error: 'FORBIDDEN: this route is for the panel only and needs an Origin' });
      }
      if (route.token && !(token && checkBearer(req.headers, token))) {
        return sendJson(res, 401, { error: 'UNAUTHORIZED: this route needs Authorization: Bearer <the relay token>' });
      }
      let body;
      if (route.bytes) {
        requireOctetStream(req);
        body = await readBytesBody(req, route.bytes);
      } else if (route.mutating) {
        requireJson(req);
        body = await readJsonBody(req);
      }
      const query = new URL(req.url, 'http://localhost').searchParams;
      const out = await route.handler({ params: m.slice(1).map(decodeURIComponent), query, body });
      if (out && out.status && out.body) return sendJson(res, out.status, out.body);
      return sendJson(res, 200, out);
    }
    if (allowed) return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return sendJson(res, 404, { error: 'NOT_FOUND' });
  }

  const server = http.createServer((req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    dispatch(req, res).catch((err) => {
      if (!(err instanceof CodedError)) console.error('code-browser: request failed:', err);
      sendJson(res, statusFor(err), { error: `${err.code ?? 'INTERNAL'}: ${describeError(err)}`, ...detailsOf(err) });
    });
  });
  server.on('clientError', (err, socket) => {
    socket.on('error', () => {});
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n' +
        "Content-Security-Policy: default-src 'none'\r\nX-Content-Type-Options: nosniff\r\n\r\n");
    }
  });
  if (onUpgrade || onRelayUpgrade) {
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {});
      // Nothing an upgrade handler does may take the process down: refuse or drop the socket instead.
      try {
        if (parsePathname(req.url) === null) {
          socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        // The CDP relay is for local programs (no Origin, direct only); every other upgrade is the panel's.
        const relay = parsePathname(req.url).startsWith(RELAY_PREFIX);
        const refusal = relay
          ? relayRefusal(req.headers, { listenPort: listenPort() })
          : requestRefusal(req.headers, { requireOrigin: true, listenPort: listenPort() });
        if (refusal) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        const handler = relay ? onRelayUpgrade : onUpgrade;
        if (!handler) {
          socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        handler(req, socket, head);
      } catch (err) {
        console.error('code-browser: upgrade failed:', err);
        socket.destroy();
      }
    });
  }
  return server;
}
