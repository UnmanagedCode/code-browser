import { promises as fs, constants } from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { PROTOCOL } from './proxyProtocol.js';

// The CDP proxy's rendezvous directory, <dataDir>/proxy/: two files, each with a single writer. The backend
// writes the shared secret (backendFile); the proxy writes where it listens (proxyFile). The proxy finds this
// directory by walking up from its own script, so neither side needs configuring.
const { dir: DIR, backendFile: SECRET_FILE, proxyFile: HOST_FILE } = PROTOCOL.rendezvous;
const SECRET_BYTES = 32;

// Opened non-blocking and without following a symlink, and checked on the open descriptor before any read, so a
// FIFO planted in the rendezvous dir can't block a read, a planted link isn't followed and a huge file can't bloat it.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

export const proxyDir = (dataDir) => path.join(dataDir, DIR);
const secretPath = (dataDir) => path.join(proxyDir(dataDir), SECRET_FILE);
const hostPath = (dataDir) => path.join(proxyDir(dataDir), HOST_FILE);

const unusable = (file, why) => Object.assign(new Error(`${file} ${why}`), { code: 'EUNUSABLE' });

// The text of `file` if it is a regular file of at most maxRendezvousBytes; null when it doesn't exist.
// Throws (`code: 'EUNUSABLE'`) naming why it can't be used. `tighten` sets the open file to 0600.
async function readSmall(file, { tighten = false } = {}) {
  let handle;
  try {
    handle = await fs.open(file, OPEN_FLAGS);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e.code === 'ELOOP') throw unusable(file, 'is a symlink');
    throw e;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw unusable(file, 'is not a regular file');
    if (info.size > PROTOCOL.maxRendezvousBytes) throw unusable(file, `is larger than ${PROTOCOL.maxRendezvousBytes} bytes`);
    // A read may return less than asked: read on until EOF or one byte past the bound.
    const buf = Buffer.alloc(PROTOCOL.maxRendezvousBytes + 1);
    let total = 0;
    while (total < buf.length) {
      const { bytesRead } = await handle.read(buf, total, buf.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > PROTOCOL.maxRendezvousBytes) throw unusable(file, `is larger than ${PROTOCOL.maxRendezvousBytes} bytes`);
    if (tighten) await handle.chmod(0o600);
    return buf.subarray(0, total).toString('utf8');
  } finally {
    await handle.close();
  }
}

function secretOf(raw) {
  try {
    const obj = JSON.parse(raw);
    const ok = obj && typeof obj === 'object' && !Array.isArray(obj) && typeof obj.secret === 'string' && obj.secret.length >= PROTOCOL.minSecretLength;
    return ok ? obj.secret : null;
  } catch {
    return null;
  }
}

// The shared secret, creating the secret file when it is missing or invalid (an unusable file, a symlink included)
// and otherwise keeping it, tightened to 0600. The directory is (re)made 0700; a new file is written 0600 through a
// tmp file created exclusively (a symlink planted at the tmp path is removed, never followed) and a rename, which
// replaces a planted link rather than writing through it.
export async function ensureSecret(dataDir) {
  const dir = proxyDir(dataDir);
  const file = secretPath(dataDir);
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    const raw = await readSmall(file, { tighten: true }).catch((e) => { if (e.code === 'EUNUSABLE') return null; throw e; });
    const existing = raw === null ? null : secretOf(raw);
    if (existing) return existing;
    const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
    const tmp = path.join(dir, `.${SECRET_FILE}.${process.pid}.tmp`);
    await fs.rm(tmp, { force: true });
    const handle = await fs.open(tmp, 'wx', 0o600);
    try {
      await handle.chmod(0o600); // the create mode is narrowed by the umask
      await handle.writeFile(`${JSON.stringify({ protocolVersion: PROTOCOL.protocolVersion, secret })}\n`);
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
    return secret;
  } catch (e) {
    throw new Error(`cannot provision the CDP proxy secret in ${file}: ${e.message}`);
  }
}

// Where the proxy listens: null when it has published nothing; `{error}` when the file can't be read or used
// (another protocol version included); else `{listenHost, listenPort, pid}`.
export async function readHost(dataDir) {
  const file = hostPath(dataDir);
  let raw;
  try {
    raw = await readSmall(file);
  } catch (e) {
    return { error: e.code === 'EUNUSABLE' ? e.message : `cannot read ${file}: ${e.message}` };
  }
  return raw === null ? null : parseHost(raw, file);
}

export function parseHost(raw, file) {
  let obj;
  try { obj = JSON.parse(raw); } catch { return { error: `${file} is not valid JSON` }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: `${file} is not a JSON object` };
  if (obj.protocolVersion !== PROTOCOL.protocolVersion) {
    return { error: `the proxy on the host speaks protocol ${JSON.stringify(obj.protocolVersion)}, this code-browser speaks ${PROTOCOL.protocolVersion} — update the proxy/ copy on the host` };
  }
  const m = typeof obj.listen === 'string' ? /^(.+):(\d{1,5})$/.exec(obj.listen) : null;
  const listenPort = m ? Number(m[2]) : NaN;
  if (!m || !net.isIPv4(m[1]) || listenPort < 1 || listenPort > 65535) return { error: `${file}: listen ${JSON.stringify(obj.listen)} is not <ipv4>:<port>` };
  if (!Number.isInteger(obj.pid) || obj.pid <= 0) return { error: `${file}: pid ${JSON.stringify(obj.pid)} is not a positive integer` };
  return { listenHost: m[1], listenPort, pid: obj.pid };
}
