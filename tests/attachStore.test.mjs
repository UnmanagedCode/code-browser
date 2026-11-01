import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attachedDir, attachedNames, parseAttachTarget, readAttached, removeAttached, writeAttached } from '../src/attachStore.js';
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

// Invariant: only a loopback port is accepted (localhost canonicalised to 127.0.0.1), via proxy or direct; anything
// else is BAD_ENDPOINT, so the backend never dials an arbitrary host.
test('parseAttachTarget accepts loopback ports only', () => {
  assert.deepEqual(parseAttachTarget({ address: '127.0.0.1:9222', via: 'proxy' }), { address: '127.0.0.1:9222', port: 9222, via: 'proxy' });
  assert.deepEqual(parseAttachTarget({ address: ' localhost:1 ', via: 'direct' }), { address: '127.0.0.1:1', port: 1, via: 'direct' });
  assert.equal(parseAttachTarget({ address: '127.0.0.1:65535', via: 'proxy' }).port, 65535);
  for (const body of [
    { address: '10.0.0.1:9222', via: 'proxy' }, { address: 'example.com:9222', via: 'direct' }, { address: '127.0.0.2:9222', via: 'direct' },
    { address: '[::1]:9222', via: 'direct' }, { address: '127.0.0.1:0', via: 'proxy' }, { address: '127.0.0.1:65536', via: 'proxy' },
    { address: '127.0.0.1', via: 'proxy' }, { address: 'http://127.0.0.1:9222', via: 'proxy' }, { address: 9222, via: 'proxy' },
    { address: '127.0.0.1:9222', via: 'lan' }, { address: '127.0.0.1:9222' }, null,
  ]) {
    assert.throws(() => parseAttachTarget(body), (e) => e.code === 'BAD_ENDPOINT', JSON.stringify(body));
  }
});

// Invariant: a stored record passes the same validator as the form: bad JSON, a non-loopback address, a port outside
// 1-65535 or an unknown via is warned about and read as none.
test('malformed records are warned about and ignored', () => {
  const d = tmpDir();
  fs.mkdirSync(attachedDir(d), { recursive: true });
  const warns = [];
  const bad = [['a', '{nope'], ['b', '{"address":"10.0.0.1:9222","via":"proxy"}'], ['c', '{"address":"127.0.0.1:9222","via":"lan"}'],
    ['d', '{"address":"127.0.0.1:0","via":"proxy"}'], ['e', '{"address":"127.0.0.1:99999","via":"direct"}']];
  for (const [n, text] of bad) {
    fs.writeFileSync(path.join(attachedDir(d), `${n}.json`), text);
    assert.equal(readAttached(d, n, { warn: (m) => warns.push(m) }), null, n);
  }
  assert.equal(warns.length, bad.length);
  fs.writeFileSync(path.join(attachedDir(d), 'Bad Name.json'), '{}');
  assert.deepEqual(attachedNames(d).sort(), bad.map(([n]) => n), 'names outside NAME_RE are never listed');
});
