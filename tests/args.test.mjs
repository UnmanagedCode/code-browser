import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, isSandboxFailure } from '../src/chromium/args.js';

const args = buildArgs({ profileDir: '/data/profiles/a' });

// Invariant: CDP is reachable only on loopback, on a port Chromium picks, against this profile.
test('loopback CDP on port 0 with the profile as user-data-dir', () => {
  assert.ok(args.includes('--remote-debugging-port=0'));
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(args.includes('--user-data-dir=/data/profiles/a'));
  assert.ok(args.includes('--headless=new'));
  assert.equal(args.at(-1), 'about:blank');
});

// Invariant: nothing weakens Chromium's own CDP origin guard or blocks the local network.
test('never passes --remote-allow-origins, a proxy or host-resolver rules', () => {
  for (const sandbox of [true, false]) {
    for (const a of buildArgs({ profileDir: '/p', sandbox })) {
      assert.doesNotMatch(a, /^--(remote-allow-origins|host-resolver-rules|proxy-server|proxy-pac-url)/);
    }
  }
});

// Invariant: --no-sandbox appears only when the sandbox was found unusable.
test('--no-sandbox only when sandbox is false', () => {
  assert.ok(!args.includes('--no-sandbox'));
  assert.ok(buildArgs({ profileDir: '/p', sandbox: false }).includes('--no-sandbox'));
});

// Invariant: the sandbox fallback triggers on Chromium's known failure messages and nothing else.
test('sandbox failure detection matches known messages only', () => {
  assert.ok(isSandboxFailure('FATAL:zygote_host_impl_linux.cc(130)] No usable sandbox! If you are running'));
  assert.ok(isSandboxFailure('Running as root without --no-sandbox is not supported.'));
  assert.ok(!isSandboxFailure('Failed to connect to the bus'));
  assert.ok(!isSandboxFailure(''));
});
