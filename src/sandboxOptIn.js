import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir, PRIVATE_FILE_MODE } from './fsPrivate.js';

// The one plugin-wide opt-in a human controls: launched browsers may run without Chromium's sandbox.
// The file exists only while the opt-in is on. Only a regular file counts: a symlink, FIFO, socket, directory or
// unreadable file is "not allowed" (warned), and is never read, written or chmod-ed through. O_NONBLOCK keeps the
// open of a FIFO from blocking, so a hostile entry at this path can neither redirect consent nor stall the boot.
export const optInFile = (dataDir) => path.join(dataDir, 'allow-unsandboxed.json');

const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

// Opens the opt-in without following a link. Returns an fd for a regular file, null when there is none, and
// otherwise null after warning why the path is not usable.
function openRegular(dataDir, log) {
  let fd;
  try { fd = fs.openSync(optInFile(dataDir), OPEN_FLAGS); } catch (err) {
    if (err.code === 'ENOENT') return null;
    log.warn(err.code === 'ELOOP'
      ? 'code-browser: the sandbox opt-in is a symlink; treating launched browsers as not allowed to run unsandboxed'
      : `code-browser: could not open the sandbox opt-in (${err.code}); treating launched browsers as not allowed to run unsandboxed`);
    return null;
  }
  if (fs.fstatSync(fd).isFile()) return fd;
  fs.closeSync(fd);
  log.warn('code-browser: the sandbox opt-in is not a regular file; treating launched browsers as not allowed to run unsandboxed');
  return null;
}

// A missing, unreadable, malformed or non-regular file is "not allowed": refusing is the safe direction.
export function allowsUnsandboxed(dataDir, log = console) {
  const fd = openRegular(dataDir, log);
  if (fd === null) return false;
  let text;
  try { text = fs.readFileSync(fd, 'utf8'); } catch (err) {
    log.warn(`code-browser: could not read the sandbox opt-in: ${err.message}`);
    return false;
  } finally { fs.closeSync(fd); }
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

// Boot: tighten an existing regular file to 0600; skip (with a warning) anything else, and never fail the boot on it.
export function tightenOptIn(dataDir, log = console) {
  const fd = openRegular(dataDir, log);
  if (fd === null) return;
  try { fs.fchmodSync(fd, PRIVATE_FILE_MODE); } finally { fs.closeSync(fd); }
}
