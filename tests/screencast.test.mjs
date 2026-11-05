import test from 'node:test';
import assert from 'node:assert/strict';
import { createScreencast } from '../src/screencast.js';
import { decodeFrame, fakeClock } from './helpers.mjs';
import { fakeJpeg } from './fakes/jpeg.mjs';

const frameParams = (n) => ({ data: fakeJpeg(100, 50, n).toString('base64'), sessionId: n, metadata: { deviceWidth: 100, deviceHeight: 50 } });

function setup(opts = {}) {
  const clock = fakeClock();
  const calls = [];
  const sc = createScreencast({ send: async (method, params, sid) => { calls.push({ method, params, sid }); return {}; }, schedule: clock.schedule, now: clock.now, maxFps: 15, ...opts });
  const viewer = (maxWidth = 800, maxHeight = 600) => {
    const v = { frames: [], buffered: 0, send: (b) => v.frames.push(decodeFrame(b)), bufferedAmount: () => v.buffered, maxWidth, maxHeight };
    return v;
  };
  const methods = (m) => calls.filter((c) => c.method === m);
  return { clock, calls, sc, viewer, methods };
}

// Invariant: acks to Chromium are spaced at least 1000/maxFps apart regardless of viewers.
test('acks are throttled to maxFps', () => {
  const { sc, viewer, clock, methods } = setup();
  sc.setTarget('S1', 'T1');
  sc.addViewer('a', viewer());
  sc.onFrame('S1', frameParams(1));
  sc.onFrame('S1', frameParams(2));
  assert.equal(methods('Page.screencastFrameAck').length, 1);
  clock.advance(60);
  assert.equal(methods('Page.screencastFrameAck').length, 1);
  clock.advance(10);
  assert.deepEqual(methods('Page.screencastFrameAck').map((c) => c.params.sessionId), [1, 2]);
  assert.equal(methods('Page.screencastFrameAck')[0].sid, 'S1');
});

// Invariant: a viewer that has not acked its last frame receives only the newest frame afterwards (latest wins).
test('a slow viewer skips stale frames; a fast viewer is unaffected', () => {
  const { sc, viewer, clock } = setup();
  sc.setTarget('S1', 'T1');
  const slow = viewer();
  const fast = viewer();
  sc.addViewer('slow', slow);
  sc.addViewer('fast', fast);
  for (let n = 1; n <= 5; n++) {
    sc.onFrame('S1', frameParams(n));
    sc.viewerAck('fast');
    clock.advance(70);
  }
  assert.deepEqual(slow.frames.map((f) => f.header.seq), [1]);
  assert.deepEqual(fast.frames.map((f) => f.header.seq), [1, 2, 3, 4, 5]);
  sc.viewerAck('slow');
  assert.deepEqual(slow.frames.map((f) => f.header.seq), [1, 5]);
});

// Invariant: a viewer whose socket buffer is above the high-water mark gets nothing until it drains, then the newest frame.
test('the high-water mark holds frames back and a retry delivers the newest', () => {
  const { sc, viewer, clock } = setup({ highWater: 1000, retryMs: 100 });
  sc.setTarget('S1', 'T1');
  const v = viewer();
  v.buffered = 5000;
  sc.addViewer('a', v);
  sc.onFrame('S1', frameParams(1));
  sc.onFrame('S1', frameParams(2));
  clock.advance(100);
  assert.equal(v.frames.length, 0, 'still congested');
  v.buffered = 0;
  clock.advance(100);
  assert.deepEqual(v.frames.map((f) => f.header.seq), [2]);
});

// Invariant: the screencast runs only while someone watches, sized to the largest viewer and clamped.
test('starts with the first viewer, resizes to the largest, stops with the last', () => {
  const { sc, viewer, methods } = setup({ maxDim: 1000 });
  sc.setTarget('S1', 'T1');
  assert.equal(methods('Page.startScreencast').length, 0, 'no viewer yet');
  sc.addViewer('a', viewer(500, 400));
  assert.deepEqual(methods('Page.startScreencast')[0].params, { format: 'jpeg', quality: 60, maxWidth: 500, maxHeight: 400 });
  sc.addViewer('b', viewer(5000, 300));
  assert.equal(methods('Page.stopScreencast').length, 1, 'restarted for new dims');
  assert.deepEqual(methods('Page.startScreencast')[1].params, { format: 'jpeg', quality: 60, maxWidth: 1000, maxHeight: 400 });
  sc.removeViewer('b');
  assert.deepEqual(methods('Page.startScreencast')[2].params, { format: 'jpeg', quality: 60, maxWidth: 500, maxHeight: 400 }, 'shrinks back');
  sc.removeViewer('a');
  assert.equal(methods('Page.stopScreencast').length, 3);
  assert.equal(methods('Page.stopScreencast').at(-1).sid, 'S1');
  sc.addViewer('c', viewer());
  assert.equal(methods('Page.startScreencast').length, 4);
});

// Invariant: after a tab switch frames from the old tab are never shown, and the new tab gets its own screencast.
test('stale tab frames are dropped and pending frames cleared on a tab switch', () => {
  const { sc, viewer, methods } = setup();
  sc.setTarget('S1', 'T1');
  const v = viewer();
  sc.addViewer('a', v);
  sc.onFrame('S1', frameParams(1));
  sc.onFrame('S1', frameParams(2)); // pending: the viewer has not acked frame 1
  sc.setTarget('S2', 'T2');
  sc.onFrame('S1', frameParams(3)); // late frame from the old tab's session
  assert.equal(methods('Page.stopScreencast')[0].sid, 'S1');
  assert.equal(methods('Page.startScreencast').at(-1).sid, 'S2');
  sc.viewerAck('a');
  assert.deepEqual(v.frames.map((f) => f.header.tabId), ['T1'], 'neither the pending nor the late T1 frame was delivered');
  sc.onFrame('S2', frameParams(4));
  assert.equal(v.frames.at(-1).header.tabId, 'T2');
});

// Invariant: a viewer that joins late immediately gets the latest frame, with the CDP metadata in the header.
test('a late joiner receives the cached frame', () => {
  const { sc, viewer } = setup();
  sc.setTarget('S1', 'T1');
  sc.addViewer('a', viewer());
  sc.onFrame('S1', frameParams(1));
  const late = viewer();
  sc.addViewer('b', late);
  assert.equal(late.frames.length, 1);
  assert.equal(late.frames[0].header.width, 100);
  assert.equal(late.frames[0].header.height, 50);
  assert.equal(late.frames[0].header.meta.deviceWidth, 100);
  assert.ok(late.frames[0].jpeg.equals(fakeJpeg(100, 50, 1)));
});

// Invariant: a tab switch drops the cache, so a joiner never sees the previous tab.
test('a tab switch drops the cached frame', () => {
  const { sc, viewer } = setup();
  sc.setTarget('S1', 'T1');
  sc.addViewer('a', viewer());
  sc.onFrame('S1', frameParams(1));
  sc.setTarget('S2', 'T2');
  const late = viewer();
  sc.addViewer('b', late);
  assert.equal(late.frames.length, 0);
});

// Invariant: onStart reports the tab each time a screencast starts on it (someone watches), and never while nobody does.
test('onStart fires when a screencast starts on a tab, not without viewers', () => {
  const started = [];
  const { sc, viewer } = setup({ onStart: (tabId) => started.push(tabId) });
  sc.setTarget('S1', 'T1');
  assert.deepEqual(started, [], 'no viewer, no screencast');
  sc.addViewer('a', viewer());
  assert.deepEqual(started, ['T1']);
  sc.setTarget('S2', 'T2');
  assert.deepEqual(started, ['T1', 'T2']);
  sc.removeViewer('a');
  sc.setTarget('S1', 'T1');
  assert.deepEqual(started, ['T1', 'T2']);
});

// Invariant: onViewers reports every viewer's requested size after each add, update and remove.
test('onViewers fires with the sizes on add, update and remove', () => {
  const seen = [];
  const { sc, viewer } = setup({ onViewers: (s) => seen.push(s) });
  sc.addViewer('a', viewer(800, 600));
  sc.addViewer('b', viewer(400, 300));
  sc.updateViewer('a', { maxWidth: 1000, maxHeight: 500 });
  sc.removeViewer('b');
  assert.deepEqual(seen, [
    [{ maxWidth: 800, maxHeight: 600 }],
    [{ maxWidth: 800, maxHeight: 600 }, { maxWidth: 400, maxHeight: 300 }],
    [{ maxWidth: 1000, maxHeight: 500 }, { maxWidth: 400, maxHeight: 300 }],
    [{ maxWidth: 1000, maxHeight: 500 }],
  ]);
});
