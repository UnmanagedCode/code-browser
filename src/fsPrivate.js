import fs from 'node:fs';

// Everything under the data dir is private to the host user: the logs hold visited URLs, and a profile's
// DevToolsActivePort exposes CDP. Modes are enforced with chmod, so directories and files that already exist
// (created by an older run, or under a permissive umask) are tightened too.
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  fs.chmodSync(dir, PRIVATE_DIR_MODE);
}

export function writePrivateFile(file, data) {
  fs.writeFileSync(file, data, { mode: PRIVATE_FILE_MODE });
  fs.chmodSync(file, PRIVATE_FILE_MODE);
}
