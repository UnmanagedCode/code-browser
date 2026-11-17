import fs from 'node:fs';
import path from 'node:path';

// One-shot, idempotent: the sandbox opt-in is one plugin-wide setting (`allow-unsandboxed.json`), so the
// per-browser `settings/` directory is dropped. Grants are never promoted: the global setting starts off and a
// human turns it on once. Applied when `settings/` no longer exists; any other error refuses the boot.
export function migrateSandboxOptIn(dataDir, log = console) {
  const settings = path.join(dataDir, 'settings');
  try { fs.lstatSync(settings); } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  let count = 0;
  try { count = fs.readdirSync(settings).filter((n) => n.endsWith('.json')).length; } catch (err) {
    if (err.code !== 'ENOTDIR') throw err;
  }
  fs.rmSync(settings, { recursive: true, force: true });
  log.log(`code-browser: dropped ${count} per-browser sandbox opt-in(s) (settings/); running without the sandbox is now one setting for every launched browser, off until a human allows it in the panel`);
}
