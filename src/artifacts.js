import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CodedError } from './errors.js';
import { ensurePrivateDir, writePrivateFile } from './fsPrivate.js';
import { ARTIFACTS_KEEP } from './limits.js';

// Bytes a program hands the backend to keep (POST api/artifacts): screenshots, PDFs, downloads. Programs in cc's plan
// mode may not write files, so the backend writes them, private to the host user, and answers the path. The same dir
// is the helper's Playwright `artifactsDir`, so downloads land here too; one retention rule covers both.
export const EXT_RE = /^[a-z0-9]{1,8}$/;

export const artifactsDirOf = (dataDir) => path.join(dataDir, 'artifacts');

export function ensureArtifactsDir(dataDir) {
  const dir = artifactsDirOf(dataDir);
  ensurePrivateDir(dir);
  return dir;
}

export function saveArtifact(dataDir, bytes, ext, { keep = ARTIFACTS_KEEP } = {}) {
  if (typeof ext !== 'string' || !EXT_RE.test(ext)) throw new CodedError('BAD_REQUEST', `ext must match ${EXT_RE}`);
  const dir = ensureArtifactsDir(dataDir);
  const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`);
  writePrivateFile(file, bytes);
  prune(dir, file, keep);
  return { path: file };
}

// Keeps the newest `keep` files, the one just written always among them. Directories are left alone.
function prune(dir, kept, keep) {
  const others = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, d.name);
    if (!d.isFile() || file === kept) continue;
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (st) others.push({ file, mtime: st.mtimeMs });
  }
  others.sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? 1 : -1));
  for (const { file } of others.slice(Math.max(0, keep - 1))) fs.rmSync(file, { force: true });
}
