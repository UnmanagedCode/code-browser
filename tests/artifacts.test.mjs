import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { saveArtifact } from '../src/artifacts.js';
import { tmpDir } from './helpers.mjs';

const modeOf = (f) => fs.statSync(f).mode & 0o777;

// Invariant: an artifact is written private (0600 in a 0700 dir) under <dataDir>/artifacts with the given extension,
// holding exactly the bytes given, and its absolute path is returned.
test('saves the bytes privately and returns the path', () => {
  const dataDir = tmpDir();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]);
  const { path: file } = saveArtifact(dataDir, bytes, 'png');
  assert.equal(path.dirname(file), path.join(dataDir, 'artifacts'));
  assert.equal(path.extname(file), '.png');
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(modeOf(file), 0o600);
  assert.equal(modeOf(path.dirname(file)), 0o700);
});

// Invariant: only a short lowercase alphanumeric extension is accepted, so the name can never leave the dir or
// pick a surprising type.
test('refuses an unsafe extension and writes nothing', () => {
  const dataDir = tmpDir();
  for (const ext of [undefined, null, '', 'PNG', '../x', 'a/b', 'p.ng', 'toolongext']) {
    assert.throws(() => saveArtifact(dataDir, Buffer.from('x'), ext), (e) => e.code === 'BAD_REQUEST', String(ext));
  }
  assert.equal(fs.existsSync(path.join(dataDir, 'artifacts')), false);
});

// Invariant: the dir keeps the newest `keep` files, the one just written always among them; subdirectories (Playwright's
// own) are left alone.
test('prunes to the newest files', () => {
  const dataDir = tmpDir();
  const dir = path.join(dataDir, 'artifacts');
  fs.mkdirSync(path.join(dir, 'playwright-sub'), { recursive: true });
  const old = [];
  for (let i = 0; i < 4; i += 1) {
    const f = path.join(dir, `old-${i}.bin`);
    fs.writeFileSync(f, 'x');
    fs.utimesSync(f, 1000 + i, 1000 + i);
    old.push(f);
  }
  const { path: newest } = saveArtifact(dataDir, Buffer.from('n'), 'bin', { keep: 3 });
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, ['old-2.bin', 'old-3.bin', path.basename(newest), 'playwright-sub'].sort());
});
