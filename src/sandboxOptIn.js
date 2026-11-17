import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir, PRIVATE_FILE_MODE } from './fsPrivate.js';

// The one plugin-wide opt-in a human controls: launched browsers may run without Chromium's sandbox.
// The file exists only while the opt-in is on. It is never read, written or chmod'ed through a symlink: a link
// planted there must not redirect consent or a write elsewhere.
export const optInFile = (dataDir) => path.join(dataDir, 'allow-unsandboxed.json');

const NOFOLLOW_READ = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;

// A missing, unreadable or symlinked file is "not allowed": refusing is the safe direction.
export function allowsUnsandboxed(dataDir, log = console) {
  let text;
  try {
    const fd = fs.openSync(optInFile(dataDir), NOFOLLOW_READ);
    try { text = fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
  } catch (err) {
    if (err.code === 'ELOOP') log.warn('code-browser: the sandbox opt-in is a symlink; treating launched browsers as not allowed to run unsandboxed');
    else if (err.code !== 'ENOENT') log.warn(`code-browser: could not read the sandbox opt-in: ${err.message}`);
    return false;
  }
  try { return JSON.parse(text)?.allowUnsandboxed === true; } catch {
    log.warn('code-browser: the sandbox opt-in is malformed; treating launched browsers as not allowed to run unsandboxed');
    return false;
  }
}

// Off unlinks the path itself (a symlink is removed, never followed). On replaces whatever is there with a fresh
// file created exclusively (`wx` fails on an existing path, links included), so nothing is written through a link.
export function setAllowUnsandboxed(dataDir, allow) {
  const file = optInFile(dataDir);
  fs.rmSync(file, { force: true });
  if (!allow) return;
  ensurePrivateDir(dataDir);
  fs.writeFileSync(file, JSON.stringify({ allowUnsandboxed: true }), { flag: 'wx', mode: PRIVATE_FILE_MODE });
}

// Boot: tighten an existing file to 0600 without following a link, and never fail the boot on one.
export function tightenOptIn(dataDir) {
  let fd;
  try { fd = fs.openSync(optInFile(dataDir), NOFOLLOW_READ); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ELOOP') return;
    throw err;
  }
  try { fs.fchmodSync(fd, PRIVATE_FILE_MODE); } finally { fs.closeSync(fd); }
}
