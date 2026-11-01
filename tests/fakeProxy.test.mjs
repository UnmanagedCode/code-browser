import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { lineReader, mac } from '../src/proxyClient.js';
import { PROTOCOL } from '../src/proxyProtocol.js';
import { ensureSecret } from '../src/proxyStore.js';
import { fakeProxy } from './fakes/fakeProxy.mjs';
import { tmpDir, within } from './helpers.mjs';

const dataDir = path.join(tmpDir(), '.code-browser');
const secret = await ensureSecret(dataDir);
const proxy = await fakeProxy(dataDir);
after(() => proxy.close());
const E = PROTOCOL.errorCodes;
const NONCE = 'n'.repeat(Math.ceil((PROTOCOL.nonceBytes * 8) / 6));

// Send one auth frame (built from the hello by `build`) and return the reply frame.
async function exchange(build) {
  const socket = net.connect(proxy.port, '127.0.0.1');
  const reader = lineReader(socket, PROTOCOL.maxFrameBytes);
  try {
    const hello = await reader.next();
    const good = { t: PROTOCOL.frames.auth, v: PROTOCOL.protocolVersion, nonce: NONCE, port: 1, mac: mac(secret, PROTOCOL.macLabels.client, hello.nonce, NONCE, 1) };
    const frame = build(good);
    socket.write(`${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n`);
    return await within(reader.next(), 2000, 'the reply');
  } finally { socket.destroy(); }
}

// Invariant: the fake proxy rejects every auth frame the real proxy rejects (tests/python/test_cdp_proxy.py
// test_bad_frames and test_version_mismatch), with the same error code, so a client frame-shape regression fails
// even when the Python tests are skipped.
test('the fake proxy refuses malformed auth frames like the real one', async () => {
  const cases = [
    [() => 'not json', E.badFrame],
    [(f) => ({ ...f, t: 'nope' }), E.badFrame],
    [(f) => ({ ...f, v: 99 }), E.versionMismatch],
    [(f) => ({ ...f, extra: 1 }), E.badFrame],
    [(f) => { const { mac: _m, ...rest } = f; return rest; }, E.badFrame],
    [(f) => ({ ...f, port: true }), E.badFrame],
    [(f) => ({ ...f, port: '9222' }), E.badFrame],
    [(f) => ({ ...f, port: 0 }), E.badFrame],
    [(f) => ({ ...f, port: 1.5 }), E.badFrame],
    [(f) => ({ ...f, nonce: 'short' }), E.badFrame],
    [(f) => ({ ...f, mac: 'ZZ' }), E.badFrame],
    [(f) => ({ ...f, mac: 'a'.repeat(64) }), E.authFailed],
  ];
  for (const [build, code] of cases) {
    const reply = await exchange(build);
    assert.equal(reply.t, PROTOCOL.frames.error, build.toString());
    assert.equal(reply.code, code, build.toString());
  }
  assert.equal((await exchange((f) => f)).t, PROTOCOL.frames.error, 'nothing listens on port 1: a well-formed frame passes to the connect');
});
