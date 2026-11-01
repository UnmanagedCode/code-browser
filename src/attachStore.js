import fs from 'node:fs';
import path from 'node:path';
import { CodedError } from './errors.js';
import { ensurePrivateDir, writePrivateFile } from './fsPrivate.js';
import { NAME_RE } from './limits.js';

// attached/<name>.json = {address, via}: a browser a human attached in the panel. It holds no secret, and its
// presence reserves the name. Written when the human attaches, removed when they forget it.
export const attachedDir = (dataDir) => path.join(dataDir, 'attached');
const recordFile = (dataDir, name) => path.join(attachedDir(dataDir), `${name}.json`);
const VIA = ['proxy', 'direct'];
const ADDRESS_RE = /^(127\.0\.0\.1|localhost):(\d{1,5})$/;

// The one validator for an attach target, whether a human typed it or it was read back from a record. Chromium's
// debug server listens on loopback only, so the address is always a loopback port: on the Docker host (through the
// proxy) or on the backend's own host (direct). The backend therefore never dials an arbitrary host.
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

// The record, or null when there is none. A malformed record is warned about and read as none.
export function readAttached(dataDir, name, log = console) {
  let text;
  try { text = fs.readFileSync(recordFile(dataDir, name), 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`code-browser: could not read the attached record for '${name}': ${err.message}`);
    return null;
  }
  try {
    const { address, via } = parseAttachTarget(JSON.parse(text));
    return { address, via };
  } catch {
    log.warn(`code-browser: the attached record for '${name}' is malformed; ignoring it`);
    return null;
  }
}

export function writeAttached(dataDir, name, { address, via }) {
  ensurePrivateDir(attachedDir(dataDir));
  writePrivateFile(recordFile(dataDir, name), JSON.stringify({ address, via }));
}

export const removeAttached = (dataDir, name) => fs.rmSync(recordFile(dataDir, name), { force: true });

export function attachedNames(dataDir) {
  try {
    return fs.readdirSync(attachedDir(dataDir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((n) => NAME_RE.test(n));
  } catch { return []; }
}
