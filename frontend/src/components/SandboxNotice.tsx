import { useState } from 'react';
import * as api from '../api';
import type { BrowserSummary } from '../protocol';

interface Props { summary: BrowserSummary; onError(message: string): void }

// Shown in place of the plain "stopped" view when a start was refused because Chromium has no usable sandbox.
// Allowing is the human's call and takes a second, explicit step.
export function SandboxNotice({ summary, onError }: Props) {
  const [confirming, setConfirming] = useState(false);
  const fail = (e: Error) => { if (!api.isSandboxRefusal(e)) onError(e.message); };

  return (
    <section className="sandbox-notice" aria-labelledby="sandbox-notice-title">
      <h2 id="sandbox-notice-title">Not started: no usable sandbox</h2>
      <p>This host cannot start Chromium&apos;s sandbox. Without it, a malicious page could take over the browser&apos;s renderer, and the browser would run it as the host user:</p>
      <ul>
        <li>the profile keeps logins and cookies;</li>
        <li>pages can reach loopback and LAN services;</li>
        <li>a compromised page runs code as the host user, with access to their files and projects.</li>
      </ul>
      {summary.allowUnsandboxed ? (
        <>
          <p>Allowed to run without the sandbox (turn it off in the browser list).</p>
          <button type="button" onClick={() => { api.startBrowser(summary.name).catch(fail); }}>Start</button>
        </>
      ) : confirming ? (
        <div className="sandbox-confirm" role="group" aria-label="Confirm running without the sandbox">
          <p>Only allow this if you trust every page this browser will visit.</p>
          <button type="button" onClick={() => { api.setAllowUnsandboxed(summary.name, true).then(() => setConfirming(false)).catch((e: Error) => onError(e.message)); }}>Allow</button>
          <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)}>Allow without sandbox…</button>
      )}
    </section>
  );
}
