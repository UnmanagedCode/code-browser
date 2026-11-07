import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pluginDir } from '../config.js';
import { CodedError } from '../errors.js';

const PATH_NAMES = ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome'];

export const installCommand = (dir = pluginDir) => `npm --prefix ${dir} run install-browser`;

// Pure: which Chromium to launch. Order: CODE_BROWSER_CHROMIUM, the build matching the bundled
// playwright-core, then PATH. An override that points nowhere fails loudly, never falls through.
export function resolveChromium({ env, exists, pwPath, pathDirs, installCmd = installCommand() }) {
  const override = env.CODE_BROWSER_CHROMIUM;
  if (override) {
    if (exists(override)) return override;
    throw new CodedError('CHROMIUM_NOT_FOUND', 'CODE_BROWSER_CHROMIUM points at a missing file', { path: override });
  }
  const tried = [];
  if (pwPath) {
    if (exists(pwPath)) return pwPath;
    tried.push(pwPath);
  }
  for (const dir of pathDirs) {
    for (const n of PATH_NAMES) {
      const candidate = path.join(dir, n);
      if (exists(candidate)) return candidate;
      tried.push(candidate);
    }
  }
  throw new CodedError('CHROMIUM_NOT_FOUND', 'No Chromium found', { tried, install: installCmd });
}

const fileExists = (p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};

export function locateChromium(env = process.env) {
  let pwPath = null;
  try {
    pwPath = createRequire(path.join(pluginDir, 'package.json'))('playwright-core').chromium.executablePath();
  } catch { /* playwright-core missing or without a revision for this platform: fall through to PATH */ }
  return resolveChromium({ env, exists: fileExists, pwPath, pathDirs: (env.PATH ?? '').split(path.delimiter).filter(Boolean) });
}
