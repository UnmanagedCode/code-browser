import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir, writePrivateFile } from './fsPrivate.js';

// Per-browser settings a human controls. `settings/<name>.json` exists only while the opt-in is on.
export const settingsDir = (dataDir) => path.join(dataDir, 'settings');
export const settingsFile = (dataDir, name) => path.join(settingsDir(dataDir), `${name}.json`);

// A missing or unreadable file is "not allowed": refusing is the safe direction.
export function allowsUnsandboxed(dataDir, name, log = console) {
  let text;
  try { text = fs.readFileSync(settingsFile(dataDir, name), 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`code-browser: could not read settings for '${name}': ${err.message}`);
    return false;
  }
  try { return JSON.parse(text)?.allowUnsandboxed === true; } catch {
    log.warn(`code-browser: settings for '${name}' are malformed; treating the browser as not allowed to run unsandboxed`);
    return false;
  }
}

export const removeSettings = (dataDir, name) => fs.rmSync(settingsFile(dataDir, name), { force: true });

export function setAllowUnsandboxed(dataDir, name, allow) {
  if (!allow) return removeSettings(dataDir, name);
  ensurePrivateDir(settingsDir(dataDir));
  writePrivateFile(settingsFile(dataDir, name), JSON.stringify({ allowUnsandboxed: true }));
}
