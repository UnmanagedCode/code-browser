// One-shot boot migration into cc's per-plugin data dir (CONDUCTOR_PLUGIN_DATA_DIR). The only code that names the
// legacy store, <PROJECTS_ROOT>/.code-browser. Delete this file and its server.js call once no install keeps a
// store at the legacy path.
import fs from 'node:fs';
import path from 'node:path';
import { PRIVATE_DIR_MODE } from './fsPrivate.js';

const lstatOrNull = (p) => {
  try { return fs.lstatSync(p); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
};

// `env` has no default on purpose: a caller must name the PROJECTS_ROOT it means, so a test can never reach the real one.
// `rename` is a seam for the cross-device branch. Every failure names both paths; the legacy store is never modified
// before the final rename (an empty target is removed and missing parents are created first).
export function migrateLegacyStore({ env, dataDir, log = console, rename = fs.renameSync }) {
  if (!env.PROJECTS_ROOT) return;
  const target = path.resolve(dataDir);
  const legacy = path.join(path.resolve(env.PROJECTS_ROOT), '.code-browser');
  if (legacy === target) return;

  const prefix = `cannot move the store ${legacy} to ${target}: `;
  const refuse = (msg) => Object.assign(new Error(prefix + msg), { refusal: true });
  try {
    const st = lstatOrNull(legacy);
    if (!st) return;
    if (!st.isDirectory()) throw refuse(`${legacy} is not a directory; remove it`);

    const existing = lstatOrNull(target);
    if (existing) {
      if (!existing.isDirectory()) throw refuse(`${target} is not a directory; remove it`);
      if (fs.readdirSync(target).length > 0) {
        throw refuse(`${target} is not empty, so nothing was moved. Keep one: delete ${legacy} to use ${target} as is, `
          + `or delete ${target} to move ${legacy} on the next start.`);
      }
      fs.rmdirSync(target);
    }

    fs.mkdirSync(path.dirname(target), { recursive: true, mode: PRIVATE_DIR_MODE });
    try {
      rename(legacy, target);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      throw refuse(`they are on different filesystems, so nothing was moved. With code-browser stopped, run `
        + `\`mv ${legacy} ${target}\` (keeps modes), or delete ${legacy} to start empty.`);
    }
  } catch (err) {
    if (err.refusal) throw err;
    err.message = prefix + err.message;
    throw err;
  }
  log.log(`code-browser: moved the store from ${legacy} to ${target}`);
}
