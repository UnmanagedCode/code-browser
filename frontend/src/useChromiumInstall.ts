import { useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { InstallState } from './protocol';
import { INSTALL_POLL_MS } from '../../src/limits.js';

// A reply without a usable `install` (a truncated or non-JSON 2xx body reads as `{}`) says nothing about the run.
const installOf = (reply: { install?: InstallState } | undefined) => (typeof reply?.install?.status === 'string' ? reply.install : null);

const INTERRUPTED = 'The install was interrupted (code-browser restarted).';

// Follows the backend's Chromium install by polling while it runs. Polling starts only from `begin` (which
// joins a run already under way) or `checkOnOpen`, and stops when the run leaves `running` or the component unmounts.
export function useChromiumInstall() {
  const [install, setInstall] = useState<InstallState | null>(null);

  const ctl = useMemo(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: InstallState['status'] | null = null;
    let alive = true;

    const show = (next: InstallState) => {
      // A followed run that turns idle was killed with the backend that ran it.
      const shown: InstallState = next.status === 'idle' && last === 'running' ? { ...next, status: 'failed', error: INTERRUPTED } : next;
      last = shown.status;
      setInstall(shown);
      clearTimeout(timer);
      if (shown.status === 'running') timer = setTimeout(poll, INSTALL_POLL_MS);
    };
    async function poll() {
      try {
        const next = installOf(await api.getInstall());
        if (!alive) return;
        if (next) show(next);
        else if (last === 'running') timer = setTimeout(poll, INSTALL_POLL_MS);
      } catch {
        // The backend is unreachable: keep what is shown and try again.
        if (alive && last === 'running') timer = setTimeout(poll, INSTALL_POLL_MS);
      }
    }
    const failLocally = (message: string) => show({ status: 'failed', error: message, exitCode: null, logTail: '' });

    // Asks the backend and follows the run, whatever its state.
    async function follow() {
      try {
        const next = installOf(await api.getInstall());
        if (!alive) return;
        if (next) show(next);
        else failLocally('The backend sent no install state.');
      } catch (e) {
        if (alive) failLocally((e as Error).message);
      }
    }

    return {
      // Asks the backend and shows the answer only when an install is running (the panel was reloaded mid-install).
      async checkOnOpen() {
        try {
          const next = installOf(await api.getInstall());
          if (alive && next?.status === 'running') show(next);
        } catch { /* nothing to show */ }
      },
      async begin() {
        try {
          const next = installOf(await api.startInstall());
          if (!alive) return;
          // The POST was accepted but its body is unreadable: the run is under way, so follow it by polling.
          if (next) show(next);
          else show({ status: 'running', error: null, exitCode: null, logTail: '' });
        } catch (e) {
          if (!alive) return;
          if (api.isInstallRunning(e)) await follow();
          else failLocally((e as Error).message);
        }
      },
      // A new not-found error starts the offer afresh, unless a run is under way.
      reset() {
        if (last === 'running') return;
        last = null;
        clearTimeout(timer);
        setInstall(null);
      },
      mount() { alive = true; return () => { alive = false; clearTimeout(timer); }; },
    };
  }, []);

  useEffect(() => ctl.mount(), [ctl]);
  // The methods are stable across renders, so effects may depend on them.
  return { install, begin: ctl.begin, reset: ctl.reset, checkOnOpen: ctl.checkOnOpen };
}
