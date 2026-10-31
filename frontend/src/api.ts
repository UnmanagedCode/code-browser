import type { BrowserSummary } from './protocol';

// A failed request: `code` is the backend's "CODE: message" prefix, when it sent one.
export class ApiError extends Error {
  readonly code: string | null;
  constructor(message: string) {
    super(message);
    this.code = /^([A-Z_]+): /.exec(message)?.[1] ?? null;
  }
}

export const isSandboxRefusal = (e: unknown) => e instanceof ApiError && e.code === 'SANDBOX_UNAVAILABLE';

// All URLs are relative: the page is served under /plugins/<id>/ and may sit behind any proxy.
async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(typeof json.error === 'string' ? json.error : `request failed (${res.status})`);
  return json;
}

const enc = encodeURIComponent;
export const createBrowser = (name: string) => call('POST', 'api/browsers', { name }) as Promise<{ browser: BrowserSummary }>;
export const startBrowser = (name: string) => call('POST', `api/browsers/${enc(name)}/start`, {});
export const stopBrowser = (name: string) => call('POST', `api/browsers/${enc(name)}/stop`, {});
export const deleteBrowser = (name: string) => call('DELETE', `api/browsers/${enc(name)}`);
export const setAllowUnsandboxed = (name: string, allow: boolean) => call('POST', `api/browsers/${enc(name)}/allow-unsandboxed`, { allow });
