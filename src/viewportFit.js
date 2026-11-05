import { DEFAULT_WINDOW, VIEWPORT_DEBOUNCE_MS, VIEWPORT_MAX_HEIGHT, VIEWPORT_MIN_HEIGHT } from './limits.js';
import { unrefTimeout } from './schedule.js';

// Keeps a LAUNCHED browser's page viewport the shape of the largest viewer's panel, so the screencast frame fills the
// panel instead of being letterboxed. The width stays `width`; the height follows the panel's aspect, clamped, and
// changes only after the panel has been stable for `debounceMs`.
//
// This is the only module that sends Emulation.* (or any resize) commands, and browserSession creates it only for
// launched browsers: a person's own (attached) browser is never resized.
export function createViewportFit({
  send,
  schedule = unrefTimeout,
  debounceMs = VIEWPORT_DEBOUNCE_MS,
  width = DEFAULT_WINDOW.width,
  initialHeight = DEFAULT_WINDOW.height,
  minHeight = VIEWPORT_MIN_HEIGHT,
  maxHeight = VIEWPORT_MAX_HEIGHT,
  onError = () => {},
}) {
  const tabs = new Set();
  let current = initialHeight;
  let pending = null; // { height, cancel }

  const override = (sessionId, height) => {
    // A tab that closed mid-send is expected.
    send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false }, sessionId).catch(onError);
  };

  return {
    addTab(sessionId) {
      tabs.add(sessionId);
      override(sessionId, current);
    },
    removeTab(sessionId) { tabs.delete(sessionId); },
    setViewers(sizes) {
      let best = null;
      for (const s of sizes) {
        if (!(s.maxWidth > 0 && s.maxHeight > 0)) continue;
        if (!best || s.maxWidth * s.maxHeight > best.maxWidth * best.maxHeight) best = s;
      }
      if (!best) return;
      const target = Math.min(maxHeight, Math.max(minHeight, Math.round(width * best.maxHeight / best.maxWidth)));
      if (target === (pending?.height ?? current)) return;
      pending?.cancel();
      if (target === current) { pending = null; return; }
      const cancel = schedule(() => {
        pending = null;
        current = target;
        for (const sessionId of tabs) override(sessionId, target);
      }, debounceMs);
      pending = { height: target, cancel };
    },
    dispose() {
      pending?.cancel();
      pending = null;
    },
  };
}
