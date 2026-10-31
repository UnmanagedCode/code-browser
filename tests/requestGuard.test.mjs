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

// Invariant: a Host that names the backend's own port (a direct connection) must be a loopback name; a rebound
// attacker hostname with a matching Origin is refused. Other ports (a proxy's) are not judged here.
test('listenPort: direct connections must use a loopback host', () => {
  const listenPort = 7471;
  const ok = (host) => requestRefusal({ host, origin: `http://${host}` }, { listenPort });
  assert.equal(ok('127.0.0.1:7471'), null);
  assert.equal(ok('localhost:7471'), null);
  assert.equal(ok('[::1]:7471'), null);
  assert.match(ok('evil.test:7471'), /loopback/);
  assert.match(ok('192.168.1.5:7471'), /loopback/);
  assert.match(ok('127.0.0.1.evil.test:7471'), /loopback/);
  assert.equal(ok('cc.example:3000'), null, 'a proxied Host has the proxy\'s port');
  assert.equal(requestRefusal({ host: 'evil.test:7471' }, { listenPort }) !== null, true, 'with no Origin too');
  assert.equal(requestRefusal({ host: 'evil.test:7471' }), null, 'no listenPort: the check is off');
});

// Invariant: the default port counts: a backend on 80 judges a bare Host.
test('listenPort: a Host without a port means the scheme default', () => {
  assert.match(requestRefusal({ host: 'evil.test' }, { listenPort: 80 }), /loopback/);
  assert.equal(requestRefusal({ host: 'localhost' }, { listenPort: 80 }), null);
});
