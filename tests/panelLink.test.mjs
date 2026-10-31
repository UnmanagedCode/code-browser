import test from 'node:test';
import assert from 'node:assert/strict';
import { panelPath } from '../src/panelLink.js';

// Invariant: the link is host-relative (the backend cannot know cc's public address).
test('the path has no scheme and no host', () => {
  const p = panelPath('e2e');
  assert.ok(p.startsWith('/#plugin/'));
  assert.doesNotMatch(p, /^[a-z]+:|\/\//i);
});

// Invariant: cc's shell route resolves it to the frame subpath `/?browser=<name>`: hash is `#plugin/<id>/<subpath>`.
test('it resolves through cc\'s #plugin/<id>/<subpath> shape to /?browser=<name>', () => {
  const hash = new URL(panelPath('my-b', 'code-browser'), 'http://cc.test').hash;
  const m = /^#plugin\/([^/]+)(\/.*)$/.exec(hash);
  assert.equal(m[1], 'code-browser');
  assert.equal(m[2], '/?browser=my-b');
});

// Invariant: the plugin id comes from the host when it names one.
test('it uses the supplied plugin id', () => {
  assert.match(panelPath('a', 'browser-dev'), /^\/#plugin\/browser-dev\//);
});
