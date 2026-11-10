import { saveArtifact } from './artifacts.js';
import { CodedError } from './errors.js';
import { ARTIFACT_MAX_BYTES } from './limits.js';

// REST table. Every GET handler is read-only: <img> tags and simple requests from any page can reach them.
// `mutating` routes require a JSON body (the guard enforces it before the handler runs).
// `requireOrigin` routes are for the panel only: a request with no Origin (cc's MCP bridge, curl) is refused;
// starting a Chromium install is one of them.
// `token` routes need the relay's bearer token; `bytes` routes take an application/octet-stream body of at most that
// many bytes instead of JSON.
export function buildRoutes({ manager, mcp, installer, dataDir, artifactMaxBytes = ARTIFACT_MAX_BYTES }) {
  const name = '([^/]+)';
  // A connect's failure is kept in the browser's summary (`attachError`), not thrown here.
  const accepted = (connecting, n) => {
    connecting.catch(() => {});
    return { status: 202, body: { browser: manager.summary(n) } };
  };
  return [
    { method: 'GET', path: /^\/api\/health$/, handler: () => ({ ok: true }) },
    { method: 'GET', path: /^\/api\/browsers$/, handler: () => ({ browsers: manager.list() }) },
    {
      method: 'POST', path: /^\/api\/browsers$/, mutating: true,
      handler: async ({ body }) => {
        const created = await manager.create(body.name);
        await manager.start(created.name);
        return { status: 201, body: { browser: manager.summary(created.name) } };
      },
    },
    {
      method: 'POST', path: new RegExp(`^/api/browsers/${name}/start$`), mutating: true,
      handler: async ({ params }) => { await manager.start(params[0]); return { browser: manager.summary(params[0]) }; },
    },
    {
      method: 'POST', path: new RegExp(`^/api/browsers/${name}/stop$`), mutating: true,
      handler: async ({ params }) => { await manager.stop(params[0]); return { browser: manager.summary(params[0]) }; },
    },
    {
      method: 'POST', path: new RegExp(`^/api/browsers/${name}/allow-unsandboxed$`), mutating: true, requireOrigin: true,
      handler: async ({ params, body }) => {
        if (typeof body?.allow !== 'boolean') throw new CodedError('BAD_REQUEST', 'allow must be a boolean');
        await manager.setAllowUnsandboxed(params[0], body.allow);
        return { browser: manager.summary(params[0]) };
      },
    },
    // Attach and Connect are the panel's alone: only a person connects code-browser to their own browser.
    // Both validate before answering, then connect in the background: in Chrome's approval mode the connection
    // waits on a click in Chrome. The outcome arrives as `change` (the panel's `browsers` message).
    {
      method: 'POST', path: new RegExp(`^/api/browsers/${name}/attach$`), mutating: true, requireOrigin: true,
      handler: ({ params, body }) => accepted(manager.attach(params[0], body), params[0]),
    },
    {
      method: 'POST', path: new RegExp(`^/api/browsers/${name}/connect$`), mutating: true, requireOrigin: true,
      handler: ({ params }) => accepted(manager.connect(params[0]), params[0]),
    },
    {
      method: 'DELETE', path: new RegExp(`^/api/browsers/${name}$`), mutating: true,
      handler: async ({ params }) => { await manager.delete(params[0]); return { ok: true }; },
    },
    { method: 'GET', path: /^\/api\/chromium\/install$/, handler: () => ({ install: installer.state() }) },
    {
      method: 'POST', path: /^\/api\/chromium\/install$/, mutating: true, requireOrigin: true,
      handler: () => ({ status: 202, body: { install: installer.start() } }),
    },
    // A program's bytes (a screenshot), kept under the data dir; the answer is the file's path.
    {
      method: 'POST', path: /^\/api\/artifacts$/, token: true, bytes: artifactMaxBytes,
      handler: ({ query, body }) => ({ status: 201, body: saveArtifact(dataDir, body, query.get('ext')) }),
    },
    {
      method: 'POST', path: /^\/api\/mcp$/, mutating: true,
      handler: async ({ body }) => {
        if (typeof body !== 'object' || body === null) throw new CodedError('BAD_REQUEST', 'body must be an object');
        return mcp.handle(body);
      },
    },
  ];
}
