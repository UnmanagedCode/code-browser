import type { AttachVia, BrowserSummary, InstallState } from './protocol';

// Splits the backend's "CODE: message" text; `code` is null when it sent no prefix.
export function splitCode(text: string): { code: string | null; message: string } {
  const m = /^([A-Z_]+): /.exec(text);
  return m ? { code: m[1], message: text.slice(m[0].length) } : { code: null, message: text };
}

// A failed request: `code` is the backend's "CODE: message" prefix, when it sent one.
export class ApiError extends Error {
  readonly code: string | null;
  // The backend's machine-readable extras (`details`), when it sent a plain object.
  readonly details: Record<string, unknown> | null;
  constructor(message: string, details: Record<string, unknown> | null = null) {
    super(message);
    this.code = splitCode(message).code;
    this.details = details;
  }
}

export const isSandboxRefusal = (e: unknown) => e instanceof ApiError && e.code === 'SANDBOX_UNAVAILABLE';
// No Chromium to start, with a command that installs one. (An override path that points nowhere carries no `install`.)
export const isChromiumMissing = (e: unknown): e is ApiError & { details: { install: string } } =>
  e instanceof ApiError && e.code === 'CHROMIUM_NOT_FOUND' && typeof e.details?.install === 'string';
export const isInstallRunning = (e: unknown) => e instanceof ApiError && e.code === 'INSTALL_RUNNING';

// All URLs are relative: the page is served under /plugins/<id>/ and may sit behind any proxy.
async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const details = typeof json.details === 'object' && json.details !== null && !Array.isArray(json.details) ? json.details : null;
    throw new ApiError(typeof json.error === 'string' ? json.error : `request failed (${res.status})`, details);
  }
  return json;
}

const enc = encodeURIComponent;
export const createBrowser = (name: string) => call('POST', 'api/browsers', { name }) as Promise<{ browser: BrowserSummary }>;
export const startBrowser = (name: string) => call('POST', `api/browsers/${enc(name)}/start`, {});
export const stopBrowser = (name: string) => call('POST', `api/browsers/${enc(name)}/stop`, {});
export const deleteBrowser = (name: string) => call('DELETE', `api/browsers/${enc(name)}`);
export const setAllowUnsandboxed = (name: string, allow: boolean) => call('POST', `api/browsers/${enc(name)}/allow-unsandboxed`, { allow });
export const attachBrowser = (name: string, address: string, via: AttachVia) => call('POST', `api/browsers/${enc(name)}/attach`, { address, via });
export const connectBrowser = (name: string) => call('POST', `api/browsers/${enc(name)}/connect`, {});
export const getInstall = () => call('GET', 'api/chromium/install') as Promise<{ install: InstallState }>;
export const startInstall = () => call('POST', 'api/chromium/install', {}) as Promise<{ install: InstallState }>;
