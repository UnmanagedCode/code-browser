// One-shot boot migration into cc's per-plugin data dir (CONDUCTOR_PLUGIN_DATA_DIR). The only code that names the
// legacy store, <PROJECTS_ROOT>/.code-browser. Delete this file and its server.js call once no install keeps a
// store at the legacy path.
import fs from 'node:fs';
import path from 'node:path';
import { PRIVATE_DIR_MODE } from './fsPrivate.js';

// `env` has no default on purpose: a caller must name the PROJECTS_ROOT it means, so a test can never reach the real one.
// `rename` is a seam for the cross-device branch.
export function migrateLegacyStore({ env, dataDir, log = console, rename = fs.renameSync }) {
  if (!env.PROJECTS_ROOT) return;
  const target = path.resolve(dataDir);
  const legacy = path.join(path.resolve(env.PROJECTS_ROOT), '.code-browser');
  if (legacy === target) return;

  let st;
  try { st = fs.lstatSync(legacy); } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (!st.isDirectory()) throw new Error(`cannot move the store ${legacy} to ${target}: ${legacy} is not a directory; remove it`);

  let targetExists = true;
  try { fs.lstatSync(target); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    targetExists = false;
  }
  if (targetExists) {
    let entries = null;
    try { entries = fs.readdirSync(target); } catch { /* not a directory */ }
    if (!entries || entries.length > 0) {
      throw new Error(`cannot move the store ${legacy} to ${target}: ${target} is not empty, so nothing was moved. `
        + `Keep one: delete ${legacy} to use ${target} as is, or delete ${target} to move ${legacy} on the next start.`);
    }
    fs.rmdirSync(target);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    rename(legacy, target);
  } catch (err) {
    if (err.code === 'EXDEV') {
      throw new Error(`cannot move the store ${legacy} to ${target}: they are on different filesystems, so nothing was moved. `
        + `With code-browser stopped, run \`mv ${legacy} ${target}\` (keeps modes), or delete ${legacy} to start empty.`);
    }
    err.message = `cannot move the store ${legacy} to ${target}: ${err.message}`;
    throw err;
  }
  log.log(`code-browser: moved the store from ${legacy} to ${target}`);
}
