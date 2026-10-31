import test from 'node:test';
import assert from 'node:assert/strict';
import { requestRefusal } from '../src/requestGuard.js';

// Invariant: a request that carries an Origin passes only when Origin's host:port equals Host.
test('matching Origin and Host passes; mismatched host or port is refused', () => {
  assert.equal(requestRefusal({ host: '127.0.0.1:7471', origin: 'http://127.0.0.1:7471' }), null);
  assert.match(requestRefusal({ host: '127.0.0.1:7471', origin: 'http://evil.test' }), /does not match/);
  assert.match(requestRefusal({ host: '127.0.0.1:7471', origin: 'http://127.0.0.1:1' }), /does not match/);
});

// Invariant: Origin and Host are compared under Origin's scheme, so a proxy's default port matches.
test('https origin matches a Host without the default port', () => {
  assert.equal(requestRefusal({ host: 'pub.example', origin: 'https://pub.example' }), null);
  assert.equal(requestRefusal({ host: 'pub.example:443', origin: 'https://pub.example' }), null);
});

// Invariant: a request with no Origin passes (cc's server-side call), unless an Origin is required (WebSocket).
test('absent Origin passes unless requireOrigin', () => {
  assert.equal(requestRefusal({ host: '127.0.0.1:1' }), null);
  assert.equal(requestRefusal({ host: '127.0.0.1:1' }, { requireOrigin: true }), 'no Origin');
});

// Invariant: malformed Origin/Host values are refused rather than parsed leniently.
test('malformed Origin or Host is refused', () => {
  assert.ok(requestRefusal({ host: 'a', origin: 'null' }));
  assert.ok(requestRefusal({ host: 'a', origin: 'file:///x' }));
  assert.ok(requestRefusal({ host: 'a', origin: 'http://a/path' }));
  assert.ok(requestRefusal({ origin: 'http://a' }));
  assert.ok(requestRefusal({ host: 'user@a/evil' }));
});
