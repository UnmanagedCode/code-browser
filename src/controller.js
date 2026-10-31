import { CONTROL_LEASE_MS } from './limits.js';

// unref'd: a pending lease must not keep the process alive.
const defaultSchedule = (fn, ms) => {
  const h = setTimeout(fn, ms);
  h.unref();
  return () => clearTimeout(h);
};

// Who may drive one browser from the panel: nobody (the agent) or one viewer. Control is held by a
// viewerId and can be taken over. When the holder no longer views the browser (no open socket of it is
// viewing: it paused, switched browser, or disconnected) for `leaseMs`, control reverts to the agent.
export function createController({ leaseMs = CONTROL_LEASE_MS, schedule = defaultSchedule, onChange = () => {} } = {}) {
  let holder = null;
  let cancelLease = null;

  const stopLease = () => { cancelLease?.(); cancelLease = null; };

  return {
    holder: () => holder,
    kind: () => (holder ? 'human' : 'agent'),
    isHolder: (viewerId) => holder !== null && holder === viewerId,
    take(viewerId) {
      stopLease();
      if (holder === viewerId) return;
      holder = viewerId;
      onChange();
    },
    release(viewerId) {
      if (holder === null || holder !== viewerId) return false;
      stopLease();
      holder = null;
      onChange();
      return true;
    },
    // The gateway reports when no socket of a viewer views this browser any more, and when one does again.
    // Reporting "gone" repeatedly keeps the original deadline.
    viewerGone(viewerId) {
      if (holder !== viewerId || cancelLease) return;
      cancelLease = schedule(() => { cancelLease = null; holder = null; onChange(); }, leaseMs);
    },
    viewerBack(viewerId) {
      if (holder === viewerId) stopLease();
    },
  };
}
