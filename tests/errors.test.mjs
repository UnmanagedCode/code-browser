import test from 'node:test';
import assert from 'node:assert/strict';
import { CodedError, describeError } from '../src/errors.js';

// Invariant: with no details the rendering is the message and the error has no own `details`.
test('describeError without details is the message', () => {
  const e = new CodedError('X', 'plain');
  assert.equal(describeError(e), 'plain');
  assert.equal(Object.hasOwn(e, 'details'), false);
});

// Invariant: every extra (a list of paths, the install command, a multi-line log tail, a single path) survives into the
// rendered text, so a surface that shows one string loses nothing.
test('describeError renders arrays, multi-line strings and scalars', () => {
  const tried = describeError(new CodedError('X', 'No Chromium found', { tried: ['/a/chrome', '/b/chromium'], install: 'npm run install-browser' }));
  for (const s of ['No Chromium found', '/a/chrome', '/b/chromium', 'npm run install-browser']) assert.ok(tried.includes(s), s);
  assert.ok(describeError(new CodedError('X', 'm', { logTail: 'l1\nl2' })).includes('logTail:\nl1\nl2'));
  assert.ok(describeError(new CodedError('X', 'm', { path: '/nope' })).includes('/nope'));
});

// Invariant: details must be a plain object (prototype Object.prototype or null), so a surface can always spread it.
test('CodedError rejects non-object details', () => {
  for (const bad of ['s', 1, null, ['a'], new Date(), new Map(), new (class Extras {})()]) assert.throws(() => new CodedError('X', 'm', bad), TypeError);
});

// Invariant: a null-prototype object is a plain object and is accepted.
test('CodedError accepts a null-prototype details object', () => {
  const details = Object.assign(Object.create(null), { a: 1 });
  assert.equal(new CodedError('X', 'm', details).details, details);
});
