import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkBearer, ensureRelayToken, relayTokenFile } from '../src/relayToken.js';
import { tmpDir } from './helpers.mjs';

const modeOf = (f) => fs.statSync(f).mode & 0o777;

// Invariant: the token is created once, private (0600 in a 0700 dir), and the same across boots.
test('created once, private, persistent across boots', () => {
  const dataDir = tmpDir();
  const first = ensureRelayToken(dataDir);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(modeOf(relayTokenFile(dataDir)), 0o600);
  assert.equal(modeOf(path.dirname(relayTokenFile(dataDir))), 0o700);
  fs.chmodSync(relayTokenFile(dataDir), 0o644);
  assert.equal(ensureRelayToken(dataDir), first);
  assert.equal(modeOf(relayTokenFile(dataDir)), 0o600, 'a loosened mode is tightened at boot');
  assert.notEqual(ensureRelayToken(tmpDir()), first, 'each data dir has its own');
});

// Invariant: a token file that holds anything else stops the boot loudly instead of being trusted or replaced.
test('a corrupt token file is refused', () => {
  const dataDir = tmpDir();
  fs.mkdirSync(path.dirname(relayTokenFile(dataDir)), { recursive: true });
  fs.writeFileSync(relayTokenFile(dataDir), 'short');
  assert.throws(() => ensureRelayToken(dataDir), /does not hold a relay token/);
  assert.equal(fs.readFileSync(relayTokenFile(dataDir), 'utf8'), 'short');
});

// Invariant: only `Authorization: Bearer <exactly the token>` passes.
test('checkBearer accepts the exact token only', () => {
  const token = 'ab'.repeat(32);
  assert.equal(checkBearer({ authorization: `Bearer ${token}` }, token), true);
  for (const authorization of [undefined, '', token, `bearer ${token}`, `Basic ${token}`, `Bearer ${token}0`, `Bearer ${token.slice(1)}`, `Bearer ${'cd'.repeat(32)}`, `Bearer ${token} `, `Bearer  ${token}`]) {
    assert.equal(checkBearer(authorization === undefined ? {} : { authorization }, token), false, String(authorization));
  }
});
