import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewportFit } from '../src/viewportFit.js';
import { DEFAULT_WINDOW, VIEWPORT_DEBOUNCE_MS, VIEWPORT_MAX_HEIGHT, VIEWPORT_MIN_HEIGHT } from '../src/limits.js';
import { fakeClock } from './helpers.mjs';

function setup(opts = {}) {
  const clock = fakeClock();
  const calls = [];
  const fit = createViewportFit({
    send: (method, params, sessionId) => { calls.push({ method, params, sessionId }); return Promise.resolve({}); },
    schedule: clock.schedule,
    ...opts,
  });
  const heights = () => calls.map((c) => `${c.sessionId}:${c.params.height}`);
  return { clock, calls, fit, heights };
}
const settle = (clock) => clock.advance(VIEWPORT_DEBOUNCE_MS);

// Invariant: a new tab gets the documented DEFAULT_WINDOW viewport at once, before any viewer exists.
test('a new tab gets the default window size immediately', () => {
  const { fit, calls } = setup();
  fit.addTab('S1');
  assert.deepEqual(calls, [{ method: 'Emulation.setDeviceMetricsOverride', params: { width: DEFAULT_WINDOW.width, height: DEFAULT_WINDOW.height, deviceScaleFactor: 0, mobile: false }, sessionId: 'S1' }]);
});

// Invariant: a viewer's shape sets the height of every tab, once, after the debounce, keeping the width.
test('a viewer resizes every tab to its aspect after the debounce', () => {
  const { fit, clock, heights, calls } = setup();
  fit.addTab('S1'); fit.addTab('S2');
  calls.length = 0;
  fit.setViewers([{ maxWidth: 1280, maxHeight: 676 }]);
  assert.equal(calls.length, 0, 'nothing before the debounce');
  settle(clock);
  assert.deepEqual(heights(), ['S1:676', 'S2:676']);
  assert.ok(calls.every((c) => c.params.width === DEFAULT_WINDOW.width));
});

// Invariant: rapid panel changes coalesce into one application of the last shape.
test('rapid changes coalesce', () => {
  const { fit, clock, heights, calls } = setup();
  fit.addTab('S1');
  calls.length = 0;
  fit.setViewers([{ maxWidth: 1000, maxHeight: 500 }]);
  clock.advance(VIEWPORT_DEBOUNCE_MS - 1);
  fit.setViewers([{ maxWidth: 1000, maxHeight: 700 }]);
  clock.advance(VIEWPORT_DEBOUNCE_MS - 1);
  assert.equal(calls.length, 0);
  clock.advance(1);
  assert.deepEqual(heights(), ['S1:896']);
});

// Invariant: the height never leaves [VIEWPORT_MIN_HEIGHT, VIEWPORT_MAX_HEIGHT].
test('the height is clamped at both ends', () => {
  const { fit, clock, heights, calls } = setup();
  fit.addTab('S1');
  calls.length = 0;
  fit.setViewers([{ maxWidth: 2000, maxHeight: 100 }]);
  settle(clock);
  assert.deepEqual(heights(), [`S1:${VIEWPORT_MIN_HEIGHT}`]);
  calls.length = 0;
  fit.setViewers([{ maxWidth: 100, maxHeight: 2000 }]);
  settle(clock);
  assert.deepEqual(heights(), [`S1:${VIEWPORT_MAX_HEIGHT}`]);
});

// Invariant: with several viewers, the one with the largest area decides.
test('the largest-area viewer wins', () => {
  const { fit, clock, heights, calls } = setup();
  fit.addTab('S1');
  calls.length = 0;
  fit.setViewers([{ maxWidth: 400, maxHeight: 800 }, { maxWidth: 1280, maxHeight: 640 }, { maxWidth: 600, maxHeight: 600 }]);
  settle(clock);
  assert.deepEqual(heights(), ['S1:640']);
});

// Invariant: no viewer, or one that has not reported a size, never re-lays-out the agent's page.
test('zero or no viewers keep the current height', () => {
  const { fit, clock, calls } = setup();
  fit.addTab('S1');
  calls.length = 0;
  fit.setViewers([]);
  fit.setViewers([{ maxWidth: 0, maxHeight: 0 }]);
  settle(clock);
  assert.equal(calls.length, 0);
  assert.equal(clock.pending(), 0);
});

// Invariant: an unchanged height is not re-sent, and a change back to the current height cancels a pending one.
test('equal heights are not re-sent', () => {
  const { fit, clock, calls } = setup();
  fit.addTab('S1');
  calls.length = 0;
  fit.setViewers([{ maxWidth: 1280, maxHeight: DEFAULT_WINDOW.height }]);
  settle(clock);
  assert.equal(calls.length, 0);
  fit.setViewers([{ maxWidth: 1280, maxHeight: 700 }]);
  fit.setViewers([{ maxWidth: 1280, maxHeight: DEFAULT_WINDOW.height }]);
  settle(clock);
  assert.equal(calls.length, 0);
});

// Invariant: a removed tab receives nothing further; a later tab starts at the current height; dispose cancels a pending apply.
test('removed tabs get nothing, new tabs get the current height, dispose cancels', () => {
  const { fit, clock, heights, calls } = setup();
  fit.addTab('S1'); fit.addTab('S2');
  fit.removeTab('S1');
  calls.length = 0;
  fit.setViewers([{ maxWidth: 1280, maxHeight: 676 }]);
  settle(clock);
  assert.deepEqual(heights(), ['S2:676']);
  calls.length = 0;
  fit.addTab('S3');
  assert.deepEqual(heights(), ['S3:676']);
  fit.setViewers([{ maxWidth: 1280, maxHeight: 900 }]);
  fit.dispose();
  settle(clock);
  assert.equal(calls.length, 1);
});

// Invariant: a send failure goes to onError instead of throwing.
test('send failures are reported, not thrown', async () => {
  const errors = [];
  const fit = createViewportFit({ send: () => Promise.reject(new Error('gone')), onError: (e) => errors.push(e.message) });
  fit.addTab('S1');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(errors, ['gone']);
});

// Invariant: when the last usable viewer goes, a resize already scheduled is cancelled: a closed panel never re-lays-out the page.
test('losing every viewer cancels a pending apply', () => {
  const { fit, clock, calls } = setup();
  fit.addTab('S1');
  calls.length = 0;
  fit.setViewers([{ maxWidth: 1280, maxHeight: 676 }]);
  fit.setViewers([]);
  settle(clock);
  assert.equal(calls.length, 0);
  assert.equal(clock.pending(), 0);
});
