import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attachedDir, attachedNames, readAttached, removeAttached, writeAttached } from '../src/attachStore.js';
import { tmpDir } from './helpers.mjs';

const modeOf = (p) => fs.statSync(p).mode & 0o777;

// Invariant: a record round-trips as {address, via} only, in a 0600 file in a 0700 dir, and removal is idempotent.
test('records round-trip privately', () => {
  const d = tmpDir();
  writeAttached(d, 'mine', { address: '127.0.0.1:9222', via: 'proxy', extra: 'dropped' });
  assert.deepEqual(readAttached(d, 'mine'), { address: '127.0.0.1:9222', via: 'proxy' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(attachedDir(d), 'mine.json'), 'utf8')), { address: '127.0.0.1:9222', via: 'proxy' });
  assert.equal(modeOf(attachedDir(d)), 0o700);
  assert.equal(modeOf(path.join(attachedDir(d), 'mine.json')), 0o600);
  assert.deepEqual(attachedNames(d), ['mine']);
  removeAttached(d, 'mine');
  removeAttached(d, 'mine');
  assert.equal(readAttached(d, 'mine'), null);
});

// Invariant: a malformed record (bad JSON, a non-loopback address, an unknown via) is warned about and read as none.
test('malformed records are warned about and ignored', () => {
  const d = tmpDir();
  fs.mkdirSync(attachedDir(d), { recursive: true });
  const warns = [];
  for (const [n, text] of [['a', '{nope'], ['b', '{"address":"10.0.0.1:9222","via":"proxy"}'], ['c', '{"address":"127.0.0.1:9222","via":"lan"}']]) {
    fs.writeFileSync(path.join(attachedDir(d), `${n}.json`), text);
    assert.equal(readAttached(d, n, { warn: (m) => warns.push(m) }), null);
  }
  assert.equal(warns.length, 3);
  fs.writeFileSync(path.join(attachedDir(d), 'Bad Name.json'), '{}');
  assert.deepEqual(attachedNames(d).sort(), ['a', 'b', 'c'], 'names outside NAME_RE are never listed');
});
