import { encodeFrame, jpegSize } from './frame.js';
import { JPEG_QUALITY, MAX_FPS, MAX_FRAME_DIM, VIEWER_HIGH_WATER } from './limits.js';

const defaultSchedule = (fn, ms) => {
  const h = setTimeout(fn, ms);
  return () => clearTimeout(h);
};

// Screencast of one browser's active tab, fanned out to its viewers.
//
// Chromium sends the next frame only after Page.screencastFrameAck, so acking no sooner than
// 1000/maxFps after the previous ack is the one global throttle. Each viewer has at most one frame
// in flight; while it is busy (or its socket buffer is above the high-water mark) only the newest
// frame is kept. A slow phone therefore gets fewer frames, never stale ones, and never slows
// Chromium or the other viewers.
//
// `onStart(tabId)` runs whenever a screencast starts on a tab (someone started watching it).
export function createScreencast({
  send,
  schedule = defaultSchedule,
  now = Date.now,
  maxFps = MAX_FPS,
  quality = JPEG_QUALITY,
  maxDim = MAX_FRAME_DIM,
  highWater = VIEWER_HIGH_WATER,
  retryMs = 100,
  onStart = () => {},
  onError = (err) => console.warn('code-browser: screencast:', err.message),
}) {
  const viewers = new Map();
  let target = null; // {sessionId (CDP), tabId}
  let running = null; // dims the running screencast was started with
  let latest = null;
  let seq = 0;
  let nextAckAt = 0;
  const ackInterval = 1000 / maxFps;

  const dims = () => {
    if (viewers.size === 0) return null;
    let w = 0;
    let h = 0;
    for (const v of viewers.values()) { w = Math.max(w, v.maxWidth); h = Math.max(h, v.maxHeight); }
    return { maxWidth: Math.min(maxDim, w || maxDim), maxHeight: Math.min(maxDim, h || maxDim) };
  };

  // The target may already be gone when a stop or ack is sent, so those failures are expected.
  const quiet = (p) => p.catch(() => {});

  function sync() {
    const want = target ? dims() : null;
    if (running && (!want || want.maxWidth !== running.maxWidth || want.maxHeight !== running.maxHeight)) {
      quiet(send('Page.stopScreencast', {}, target.sessionId));
      running = null;
    }
    if (want && !running) {
      running = want;
      send('Page.startScreencast', { format: 'jpeg', quality, ...want }, target.sessionId).catch(onError);
      onStart(target.tabId);
    }
  }

  function deliver(v, frame) {
    if (!target || frame.tabId !== target.tabId) return;
    if (v.inFlight || v.bufferedAmount() >= highWater) {
      v.pending = frame;
      if (!v.inFlight && !v.cancelRetry) {
        v.cancelRetry = schedule(() => {
          v.cancelRetry = null;
          const f = v.pending;
          v.pending = null;
          if (f) deliver(v, f);
        }, retryMs);
      }
      return;
    }
    frame.encoded ??= encodeFrame({ seq: frame.seq, tabId: frame.tabId, ...frame.size, meta: frame.meta }, frame.jpeg);
    v.send(frame.encoded);
    v.inFlight = true;
  }

  function scheduleAck(cdpSessionId, ackId) {
    const at = Math.max(now(), nextAckAt);
    nextAckAt = at + ackInterval;
    const ack = () => quiet(send('Page.screencastFrameAck', { sessionId: ackId }, cdpSessionId));
    const delay = at - now();
    if (delay <= 0) ack(); else schedule(ack, delay);
  }

  return {
    setTarget(sessionId, tabId) {
      if (running) quiet(send('Page.stopScreencast', {}, target.sessionId));
      running = null;
      latest = null;
      target = sessionId ? { sessionId, tabId } : null;
      for (const v of viewers.values()) { v.cancelRetry?.(); v.cancelRetry = null; v.pending = null; }
      sync();
    },
    addViewer(id, { send: sendFrame, bufferedAmount, maxWidth = 0, maxHeight = 0 }) {
      const v = { send: sendFrame, bufferedAmount, maxWidth, maxHeight, inFlight: false, pending: null, cancelRetry: null };
      viewers.set(id, v);
      sync();
      if (latest) deliver(v, latest);
    },
    updateViewer(id, { maxWidth = 0, maxHeight = 0 }) {
      const v = viewers.get(id);
      if (!v) return;
      v.maxWidth = maxWidth;
      v.maxHeight = maxHeight;
      sync();
    },
    removeViewer(id) {
      viewers.get(id)?.cancelRetry?.();
      viewers.delete(id);
      sync();
    },
    // Page.screencastFrame from the CDP session `cdpSessionId`; `params.sessionId` is the frame's ack id.
    onFrame(cdpSessionId, params) {
      if (!target || cdpSessionId !== target.sessionId) return;
      const jpeg = Buffer.from(params.data, 'base64');
      const m = params.metadata ?? {};
      latest = {
        seq: ++seq,
        tabId: target.tabId,
        jpeg,
        size: jpegSize(jpeg) ?? {},
        meta: {
          deviceWidth: m.deviceWidth, deviceHeight: m.deviceHeight, offsetTop: m.offsetTop,
          pageScaleFactor: m.pageScaleFactor, scrollOffsetX: m.scrollOffsetX, scrollOffsetY: m.scrollOffsetY,
        },
      };
      scheduleAck(cdpSessionId, params.sessionId);
      for (const v of viewers.values()) deliver(v, latest);
    },
    viewerAck(id) {
      const v = viewers.get(id);
      if (!v) return;
      v.inFlight = false;
      const f = v.pending;
      v.pending = null;
      if (f) deliver(v, f);
    },
    viewerCount: () => viewers.size,
  };
}
