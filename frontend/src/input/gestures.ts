export type Gesture =
  | { type: 'tap'; x: number; y: number }
  | { type: 'scroll'; x: number; y: number; deltaX: number; deltaY: number };

export interface GestureOptions { slop?: number; tapMaxMs?: number }

// One-finger touch: a short, near-stationary touch is a tap (a left click); movement beyond the slop is a
// drag that scrolls the page (the finger moving up scrolls down). A second finger cancels the gesture:
// pinch is native zoom of the panel and sends nothing to the page.
export function createGestureTracker(emit: (g: Gesture) => void, { slop = 10, tapMaxMs = 300 }: GestureOptions = {}) {
  let active: { id: number; startX: number; startY: number; lastX: number; lastY: number; startT: number; dragging: boolean } | null = null;
  let cancelled = false;
  let down = 0;

  return {
    down(id: number, x: number, y: number, t: number) {
      down += 1;
      if (down > 1) { cancelled = true; active = null; return; }
      cancelled = false;
      active = { id, startX: x, startY: y, lastX: x, lastY: y, startT: t, dragging: false };
    },
    move(id: number, x: number, y: number) {
      if (!active || active.id !== id) return;
      if (!active.dragging) {
        if (Math.hypot(x - active.startX, y - active.startY) <= slop) return;
        active.dragging = true;
        active.lastX = active.startX;
        active.lastY = active.startY;
      }
      emit({ type: 'scroll', x, y, deltaX: active.lastX - x, deltaY: active.lastY - y });
      active.lastX = x;
      active.lastY = y;
    },
    up(id: number, x: number, y: number, t: number) {
      down = Math.max(0, down - 1);
      const a = active;
      if (!a || a.id !== id || cancelled) { if (down === 0) { active = null; cancelled = false; } return; }
      active = null;
      if (!a.dragging && t - a.startT <= tapMaxMs && Math.hypot(x - a.startX, y - a.startY) <= slop) emit({ type: 'tap', x, y });
    },
    cancel(id?: number) {
      down = Math.max(0, down - 1);
      if (!id || active?.id === id) active = null;
      if (down === 0) cancelled = false;
    },
  };
}
