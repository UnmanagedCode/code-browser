import { CodedError } from '../errors.js';

// `save(bytes, ext)`: hands bytes to the backend (POST api/artifacts), which writes them under its data dir, and
// resolves the file's absolute path. A program in cc's plan mode may not write files itself.
export function createSave({ url, token }) {
  return async function save(bytes, ext) {
    if (!(bytes instanceof Uint8Array)) throw new CodedError('BAD_REQUEST', 'save(bytes, ext): bytes must be a Buffer or Uint8Array');
    const res = await fetch(`${url}?ext=${encodeURIComponent(ext)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: bytes,
    });
    const answer = await res.json().catch(() => ({}));
    if (res.ok && typeof answer.path === 'string') return answer.path;
    const m = /^([A-Z][A-Z_]+): ([\s\S]*)$/.exec(answer.error ?? '');
    throw new CodedError(m?.[1] ?? 'SAVE_FAILED', m?.[2] ?? `the backend answered ${res.status}`);
  };
}
