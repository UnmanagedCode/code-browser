import http from 'node:http';
import { CodedError, statusFor } from './errors.js';
import { parsePathname, readJsonBody, requireJson, sendJson, serveStatic } from './http.js';
import { requestRefusal } from './requestGuard.js';
import { buildRoutes } from './routes.js';

// The HTTP server. Check order for every request: Origin (403) → route (404/405)
// → content type (415) → body → handler. No handler runs before the guards pass.
export function createApp({ manager, mcp, distDir, onUpgrade }) {
  const routes = buildRoutes({ manager, mcp });

  async function dispatch(req, res) {
    const refusal = requestRefusal(req.headers);
    if (refusal) return sendJson(res, 403, { error: `FORBIDDEN: ${refusal}` });
    const pathname = parsePathname(req.url);
    if (pathname === null) return sendJson(res, 400, { error: 'BAD_REQUEST: malformed request target' });
    if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(res, distDir, pathname);
    let allowed = false;
    for (const route of routes) {
      const m = route.path.exec(pathname);
      if (!m) continue;
      allowed = true;
      if (route.method !== req.method) continue;
      let body;
      if (route.mutating) {
        requireJson(req);
        body = await readJsonBody(req);
      }
      const out = await route.handler({ params: m.slice(1).map(decodeURIComponent), body });
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
      sendJson(res, statusFor(err), { error: `${err.code ?? 'INTERNAL'}: ${err.message}` });
    });
  });
  server.on('clientError', (err, socket) => {
    socket.on('error', () => {});
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n' +
        "Content-Security-Policy: default-src 'none'\r\nX-Content-Type-Options: nosniff\r\n\r\n");
    }
  });
  if (onUpgrade) {
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {});
      // Nothing an upgrade handler does may take the process down: refuse or drop the socket instead.
      try {
        if (parsePathname(req.url) === null) {
          socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        onUpgrade(req, socket, head);
      } catch (err) {
        console.error('code-browser: upgrade failed:', err);
        socket.destroy();
      }
    });
  }
  return server;
}
