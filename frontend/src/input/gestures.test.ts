import { describe, expect, it } from 'vitest';
import { createGestureTracker, type Gesture } from './gestures';

const setup = () => {
  const out: Gesture[] = [];
  return { out, g: createGestureTracker((x) => out.push(x), { slop: 10, tapMaxMs: 300 }) };
};

describe('gestures', () => {
  // Invariant: a short, near-stationary touch is a tap at the release point.
  it('a quick touch within the slop is a tap', () => {
    const { g, out } = setup();
    g.down(1, 100, 100, 0);
    g.move(1, 104, 103);
    g.up(1, 104, 103, 120);
    expect(out).toEqual([{ type: 'tap', x: 104, y: 103 }]);
  });

  // Invariant: a long press is not a tap.
  it('a slow touch is not a tap', () => {
    const { g, out } = setup();
    g.down(1, 10, 10, 0);
    g.up(1, 10, 10, 1000);
    expect(out).toEqual([]);
  });

  // Invariant: dragging beyond the slop scrolls; the finger moving up scrolls down (positive deltaY); no tap on release.
  it('a drag emits wheel deltas opposite to the finger and no tap', () => {
    const { g, out } = setup();
    g.down(1, 100, 200, 0);
    g.move(1, 100, 205); // inside slop: nothing
    g.move(1, 100, 150);
    g.move(1, 100, 120);
    g.up(1, 100, 120, 100);
    expect(out).toEqual([
      { type: 'scroll', x: 100, y: 150, deltaX: 0, deltaY: 50 },
      { type: 'scroll', x: 100, y: 120, deltaX: 0, deltaY: 30 },
    ]);
  });

  // Invariant: a second finger cancels the gesture (pinch is native zoom): no tap, no scroll, and a later touch works again.
  it('a second finger cancels, and a fresh touch afterwards is tracked', () => {
    const { g, out } = setup();
    g.down(1, 10, 10, 0);
    g.down(2, 50, 50, 10);
    g.move(1, 10, 80);
    g.up(2, 50, 50, 50);
    g.up(1, 10, 80, 60);
    expect(out).toEqual([]);
    g.down(3, 20, 20, 1000);
    g.up(3, 20, 20, 1050);
    expect(out).toEqual([{ type: 'tap', x: 20, y: 20 }]);
  });

  // Invariant: pointercancel drops the gesture without emitting.
  it('cancel emits nothing', () => {
    const { g, out } = setup();
    g.down(1, 10, 10, 0);
    g.cancel(1);
    g.up(1, 10, 10, 20);
    expect(out).toEqual([]);
  });
});
