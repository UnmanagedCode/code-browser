import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir, writePrivateFile } from './fsPrivate.js';
import { NAME_RE } from './limits.js';

// attached/<name>.json = {address, via}: a browser a human attached in the panel. It holds no secret, and its
// presence reserves the name. Written when the human attaches, removed when they forget it.
export const attachedDir = (dataDir) => path.join(dataDir, 'attached');
const recordFile = (dataDir, name) => path.join(attachedDir(dataDir), `${name}.json`);
const VIA = new Set(['proxy', 'direct']);
const ADDRESS_RE = /^127\.0\.0\.1:\d{1,5}$/;

// The record, or null when there is none. A malformed record is warned about and read as none.
export function readAttached(dataDir, name, log = console) {
  let text;
  try { text = fs.readFileSync(recordFile(dataDir, name), 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`code-browser: could not read the attached record for '${name}': ${err.message}`);
    return null;
  }
  let rec;
  try { rec = JSON.parse(text); } catch { rec = null; }
  if (!rec || typeof rec.address !== 'string' || !ADDRESS_RE.test(rec.address) || !VIA.has(rec.via)) {
    log.warn(`code-browser: the attached record for '${name}' is malformed; ignoring it`);
    return null;
  }
  return { address: rec.address, via: rec.via };
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
