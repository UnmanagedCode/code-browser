import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { tmpDir } from './helpers.mjs';

const root = new URL('..', import.meta.url).pathname;

// Invariant: the data dir is exactly CONDUCTOR_PLUGIN_DATA_DIR, never derived from PROJECTS_ROOT.
test('dataDir is the CONDUCTOR_PLUGIN_DATA_DIR value, not derived from PROJECTS_ROOT', () => {
  const data = path.join(tmpDir(), 'data');
  const cfg = loadConfig({ CONDUCTOR_PLUGIN_DATA_DIR: data, PROJECTS_ROOT: tmpDir() });
  assert.equal(cfg.dataDir, data);
});

// Invariant: core does not need PROJECTS_ROOT.
test('PROJECTS_ROOT is not needed by core', () => {
  const data = path.join(tmpDir(), 'data');
  assert.equal(loadConfig({ CONDUCTOR_PLUGIN_DATA_DIR: data }).dataDir, data);
});

// Invariant: a missing or empty data-dir variable is refused loudly.
test('loadConfig refuses an unset or empty CONDUCTOR_PLUGIN_DATA_DIR', () => {
  assert.throws(() => loadConfig({}), /CONDUCTOR_PLUGIN_DATA_DIR is not set/);
  assert.throws(() => loadConfig({ CONDUCTOR_PLUGIN_DATA_DIR: '' }), /CONDUCTOR_PLUGIN_DATA_DIR is not set/);
});

// Invariant: only src/migrateLegacyStore.js names the legacy store path.
test('only the migration file names the legacy store', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const files = [path.join(root, 'server.js'), path.join(root, 'proxy', 'cdp_proxy.py'),
    ...walk(path.join(root, 'src')).filter((f) => f.endsWith('.js') && path.basename(f) !== 'migrateLegacyStore.js')];
  assert.match('<root>/.code-browser/', /\.code-browser\b/);
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\.code-browser\b/, path.relative(root, f));
  assert.match(fs.readFileSync(path.join(root, 'src', 'migrateLegacyStore.js'), 'utf8'), /\.code-browser\b/);
});
