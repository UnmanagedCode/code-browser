import { CONTROL_LEASE_MS } from './limits.js';

const defaultSchedule = (fn, ms) => {
  const h = setTimeout(fn, ms);
  return () => clearTimeout(h);
};

// Who may drive one browser from the panel: nobody (the agent) or one viewer. Control is held by a
// viewerId and can be taken over. When the holder has no open socket for `leaseMs` it reverts to the agent.
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
    // The gateway reports when a viewer's last socket closes and when one reappears.
    viewerGone(viewerId) {
      if (holder !== viewerId) return;
      stopLease();
      cancelLease = schedule(() => { cancelLease = null; holder = null; onChange(); }, leaseMs);
    },
    viewerBack(viewerId) {
      if (holder === viewerId) stopLease();
    },
  };
}
