import { CodedError } from './errors.js';

// REST table. Every GET handler is read-only: <img> tags and simple requests from any page can reach them.
// `mutating` routes require a JSON body (the guard enforces it before the handler runs).
export function buildRoutes({ manager, mcp }) {
  const name = '([^/]+)';
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
      method: 'DELETE', path: new RegExp(`^/api/browsers/${name}$`), mutating: true,
      handler: async ({ params }) => { await manager.delete(params[0]); return { ok: true }; },
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
