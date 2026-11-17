import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir, writePrivateFile } from './fsPrivate.js';

// The one plugin-wide opt-in a human controls: launched browsers may run without Chromium's sandbox.
// The file exists only while the opt-in is on.
export const optInFile = (dataDir) => path.join(dataDir, 'allow-unsandboxed.json');

// A missing or unreadable file is "not allowed": refusing is the safe direction.
export function allowsUnsandboxed(dataDir, log = console) {
  let text;
  try { text = fs.readFileSync(optInFile(dataDir), 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`code-browser: could not read the sandbox opt-in: ${err.message}`);
    return false;
  }
  try { return JSON.parse(text)?.allowUnsandboxed === true; } catch {
    log.warn('code-browser: the sandbox opt-in is malformed; treating launched browsers as not allowed to run unsandboxed');
    return false;
  }
}

export function setAllowUnsandboxed(dataDir, allow) {
  if (!allow) return fs.rmSync(optInFile(dataDir), { force: true });
  ensurePrivateDir(dataDir);
  writePrivateFile(optInFile(dataDir), JSON.stringify({ allowUnsandboxed: true }));
}
