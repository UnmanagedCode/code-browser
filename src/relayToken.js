import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir, writePrivateFile } from './fsPrivate.js';

// The bearer token for the CDP relay and the artifacts route: 32 random bytes as hex in <dataDir>/relay/token,
// created at boot when missing and kept across boots. Tool results name the file, never the value: a process must
// be able to read the backend user's private data dir to hold the token.
const TOKEN_RE = /^[0-9a-f]{64}$/;

export const relayTokenFile = (dataDir) => path.join(dataDir, 'relay', 'token');

export function ensureRelayToken(dataDir) {
  const file = relayTokenFile(dataDir);
  ensurePrivateDir(path.dirname(file));
  let token = null;
  try { token = fs.readFileSync(file, 'utf8').trim(); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (token !== null && !TOKEN_RE.test(token)) throw new Error(`${file} does not hold a relay token; remove it to have one created`);
  if (token === null) {
    token = crypto.randomBytes(32).toString('hex');
    writePrivateFile(file, token);
  } else {
    fs.chmodSync(file, 0o600);
  }
  return token;
}

// True when `Authorization: Bearer <token>` names exactly `token`.
export function checkBearer(headers, token) {
  const m = /^Bearer ([0-9a-f]+)$/.exec(headers.authorization ?? '');
  if (!m) return false;
  const given = Buffer.from(m[1]);
  const want = Buffer.from(token);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
