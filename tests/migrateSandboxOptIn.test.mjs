import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { migrateSandboxOptIn } from '../src/migrateSandboxOptIn.js';
import { tmpDir } from './helpers.mjs';

const recorder = () => { const lines = []; return { lines, log: { log: (m) => lines.push(m) } }; };
const seed = (dataDir, entries) => {
  fs.mkdirSync(path.join(dataDir, 'settings'), { recursive: true });
  for (const [n, text] of Object.entries(entries)) fs.writeFileSync(path.join(dataDir, 'settings', n), text);
};

// Invariant: a fresh install (no data dir yet) is untouched and silent.
test('a missing data dir is a no-op', () => {
  const dataDir = path.join(tmpDir(), 'nope');
  const { lines, log } = recorder();
  migrateSandboxOptIn(dataDir, log);
  assert.equal(fs.existsSync(dataDir), false);
  assert.deepEqual(lines, []);
});

// Invariant: with no `settings/` the migration is already applied: it logs nothing and changes nothing.
test('no settings directory is a no-op without a log', () => {
  const dataDir = tmpDir();
  fs.writeFileSync(path.join(dataDir, 'keep.txt'), 'x');
  const { lines, log } = recorder();
  migrateSandboxOptIn(dataDir, log);
  assert.deepEqual(fs.readdirSync(dataDir), ['keep.txt']);
  assert.deepEqual(lines, []);
});

// Invariant: per-browser grants are dropped and never promoted to the global opt-in (fail closed); the count is logged.
test('settings are removed, counted in the log, and never promoted to the global opt-in', () => {
  const dataDir = tmpDir();
  seed(dataDir, { 'a.json': '{"allowUnsandboxed":true}', 'b.json': '{nope', 'c.txt': 'x' });
  const { lines, log } = recorder();
  migrateSandboxOptIn(dataDir, log);
  assert.equal(fs.existsSync(path.join(dataDir, 'settings')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'allow-unsandboxed.json')), false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /dropped 2 per-browser sandbox opt-in\(s\)/);
});

// Invariant: a second run finds nothing to do.
test('a second run is a no-op', () => {
  const dataDir = tmpDir();
  seed(dataDir, { 'a.json': '{"allowUnsandboxed":true}' });
  migrateSandboxOptIn(dataDir, recorder().log);
  const { lines, log } = recorder();
  migrateSandboxOptIn(dataDir, log);
  assert.deepEqual(lines, []);
});

// Invariant: an existing global opt-in (set by a human after the migration) is never touched.
test('an existing global opt-in is left untouched', () => {
  const dataDir = tmpDir();
  fs.writeFileSync(path.join(dataDir, 'allow-unsandboxed.json'), '{"allowUnsandboxed":true}');
  seed(dataDir, { 'a.json': '{}' });
  migrateSandboxOptIn(dataDir, recorder().log);
  assert.equal(fs.readFileSync(path.join(dataDir, 'allow-unsandboxed.json'), 'utf8'), '{"allowUnsandboxed":true}');
});
