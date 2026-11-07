import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChromium } from '../src/chromium/locate.js';
import { describeError } from '../src/errors.js';

const base = { env: {}, exists: () => false, pwPath: '/pw/chrome', pathDirs: ['/usr/bin', '/opt/bin'], installCmd: 'npm run install-browser' };

// Invariant: discovery order is env override, then the playwright-core build, then PATH names.
test('discovery order: env, playwright-core, PATH', () => {
  const all = new Set(['/env/chrome', '/pw/chrome', '/usr/bin/chromium', '/opt/bin/google-chrome']);
  const exists = (p) => all.has(p);
  assert.equal(resolveChromium({ ...base, exists, env: { CODE_BROWSER_CHROMIUM: '/env/chrome' } }), '/env/chrome');
  assert.equal(resolveChromium({ ...base, exists }), '/pw/chrome');
  all.delete('/pw/chrome');
  assert.equal(resolveChromium({ ...base, exists }), '/usr/bin/chromium');
  all.delete('/usr/bin/chromium');
  assert.equal(resolveChromium({ ...base, exists }), '/opt/bin/google-chrome');
});

// Invariant: an env override that points at nothing fails loudly instead of falling through to another browser.
test('a missing env override fails loudly even when others exist', () => {
  const exists = (p) => p === '/pw/chrome';
  assert.throws(
    () => resolveChromium({ ...base, exists, env: { CODE_BROWSER_CHROMIUM: '/nope' } }),
    (e) => e.code === 'CHROMIUM_NOT_FOUND' && e.details.path === '/nope' && describeError(e).includes('/nope'),
  );
});

// Invariant: when nothing is found the error lists every path tried and the exact install command.
test('not-found error carries paths tried and the install command in details, and renders them', () => {
  assert.throws(() => resolveChromium(base), (e) => {
    assert.equal(e.code, 'CHROMIUM_NOT_FOUND');
    for (const p of ['/pw/chrome', '/usr/bin/chromium', '/usr/bin/google-chrome-stable', '/opt/bin/chromium-browser']) {
      assert.ok(e.details.tried.includes(p), p);
      assert.ok(describeError(e).includes(p), p);
    }
    assert.equal(e.details.install, 'npm run install-browser');
    assert.ok(describeError(e).includes('npm run install-browser'));
    return true;
  });
});
