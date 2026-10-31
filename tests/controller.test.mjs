import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/controller.js';
import { fakeClock } from './helpers.mjs';

function make(leaseMs = 1000) {
  const clock = fakeClock();
  const changes = [];
  const c = createController({ leaseMs, schedule: clock.schedule, onChange: () => changes.push(c.holder()) });
  return { c, clock, changes };
}

// Invariant: control starts with the agent; taking it makes the viewer the (only) holder and releasing hands it back.
test('take and release', () => {
  const { c, changes } = make();
  assert.equal(c.kind(), 'agent');
  c.take('v1');
  assert.equal(c.kind(), 'human');
  assert.ok(c.isHolder('v1'));
  assert.ok(!c.isHolder('v2'));
  assert.equal(c.release('v1'), true);
  assert.equal(c.kind(), 'agent');
  assert.deepEqual(changes, ['v1', null]);
});

// Invariant: another viewer can take over; the previous holder then holds nothing.
test('a second viewer can steal control', () => {
  const { c } = make();
  c.take('v1');
  c.take('v2');
  assert.ok(c.isHolder('v2'));
  assert.ok(!c.isHolder('v1'));
});

// Invariant: only the holder can release.
test('release by a non-holder is refused', () => {
  const { c, changes } = make();
  assert.equal(c.release('v1'), false);
  c.take('v1');
  assert.equal(c.release('v2'), false);
  assert.ok(c.isHolder('v1'));
  assert.deepEqual(changes, ['v1']);
});

// Invariant: a holder with no open socket for the lease period loses control to the agent.
test('lease expiry reverts control to the agent', () => {
  const { c, clock } = make(1000);
  c.take('v1');
  c.viewerGone('v1');
  clock.advance(999);
  assert.equal(c.kind(), 'human');
  clock.advance(2);
  assert.equal(c.kind(), 'agent');
});

// Invariant: a holder that reconnects within the lease keeps control; a non-holder leaving changes nothing.
test('reconnecting within the lease keeps control', () => {
  const { c, clock } = make(1000);
  c.take('v1');
  c.viewerGone('v2');
  c.viewerGone('v1');
  clock.advance(500);
  c.viewerBack('v1');
  clock.advance(5000);
  assert.ok(c.isHolder('v1'));
  assert.equal(clock.pending(), 0);
});

// Invariant: a take during a pending lease cancels it, so the new holder is not evicted by the old one's timer.
test('a take cancels a pending lease', () => {
  const { c, clock } = make(1000);
  c.take('v1');
  c.viewerGone('v1');
  c.take('v2');
  clock.advance(5000);
  assert.ok(c.isHolder('v2'));
});
