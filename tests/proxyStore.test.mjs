import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL } from '../src/proxyProtocol.js';
import { ensureSecret, parseHost, proxyDir, readHost } from '../src/proxyStore.js';
import { tmpDir } from './helpers.mjs';

const modeOf = (p) => fs.statSync(p).mode & 0o777;
const secretFile = (d) => path.join(proxyDir(d), PROTOCOL.rendezvous.backendFile);
const hostFile = (d) => path.join(proxyDir(d), PROTOCOL.rendezvous.proxyFile);

// Invariant: the secret is created 0600 in a 0700 dir, long enough for the proxy, and a valid one is never replaced.
test('ensureSecret provisions once and keeps a valid secret', async () => {
  const d = tmpDir();
  const s1 = await ensureSecret(d);
  assert.ok(s1.length >= PROTOCOL.minSecretLength);
  assert.equal(modeOf(proxyDir(d)), 0o700);
  assert.equal(modeOf(secretFile(d)), 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(secretFile(d), 'utf8')), { protocolVersion: PROTOCOL.protocolVersion, secret: s1 });
  assert.equal(await ensureSecret(d), s1);
  assert.deepEqual(fs.readdirSync(proxyDir(d)), [PROTOCOL.rendezvous.backendFile], 'no tmp file is left');
});

// Invariant: an unusable secret file (invalid JSON, a short secret, a FIFO, an oversized file) is replaced, never used.
test('ensureSecret replaces unusable secret files', async () => {
  for (const plant of [
    (f) => fs.writeFileSync(f, '{nope'),
    (f) => fs.writeFileSync(f, JSON.stringify({ secret: 'short' })),
    (f) => execFileSync('mkfifo', [f]),
    (f) => fs.writeFileSync(f, JSON.stringify({ secret: 'x'.repeat(PROTOCOL.maxRendezvousBytes) })),
  ]) {
    const d = tmpDir();
    fs.mkdirSync(proxyDir(d), { recursive: true });
    plant(secretFile(d));
    const s = await ensureSecret(d);
    assert.ok(s.length >= PROTOCOL.minSecretLength);
    assert.ok(fs.statSync(secretFile(d)).isFile());
  }
});

// Invariant: host.json is read only when it names an IPv4 listener and a pid in this protocol version; anything
// else is an error that says why (a version mismatch says to update the proxy copy).
test('readHost and parseHost', async () => {
  const d = tmpDir();
  assert.equal(await readHost(d), null);
  fs.mkdirSync(proxyDir(d), { recursive: true });
  const v = PROTOCOL.protocolVersion;
  fs.writeFileSync(hostFile(d), JSON.stringify({ protocolVersion: v, listen: '172.17.0.1:7078', pid: 5 }));
  assert.deepEqual(await readHost(d), { listenHost: '172.17.0.1', listenPort: 7078, pid: 5 });
  assert.match(parseHost(JSON.stringify({ protocolVersion: v + 1, listen: '127.0.0.1:1', pid: 5 }), 'f').error, /update the proxy\/ copy/);
  for (const bad of ['{nope', '[]', JSON.stringify({ protocolVersion: v, listen: 'host:1', pid: 5 }), JSON.stringify({ protocolVersion: v, listen: '127.0.0.1:0', pid: 5 }), JSON.stringify({ protocolVersion: v, listen: '127.0.0.1:1', pid: 0 })]) {
    assert.ok(parseHost(bad, 'f').error, bad);
  }
  fs.rmSync(hostFile(d));
  execFileSync('mkfifo', [hostFile(d)]);
  assert.match((await readHost(d)).error, /not a regular file/);
});
