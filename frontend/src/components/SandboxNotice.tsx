import { useState } from 'react';
import * as api from '../api';
import type { BrowserSummary } from '../protocol';
import { InlineConfirm } from './InlineConfirm';
import { SandboxRisks } from './SandboxRisks';

interface Props { summary: BrowserSummary; allowed: boolean; onError(message: string): void }

// Shown in place of the plain "stopped" view when a start was refused because Chromium has no usable sandbox.
// Allowing is the human's call and takes a second, explicit step.
export function SandboxNotice({ summary, allowed, onError }: Props) {
  const [confirming, setConfirming] = useState(false);
  const fail = (e: Error) => { if (!api.isSandboxRefusal(e)) onError(e.message); };

  return (
    <section className="sandbox-notice" aria-labelledby="sandbox-notice-title">
      <h2 id="sandbox-notice-title">Not started: no usable sandbox</h2>
      <p>This host cannot start Chromium&apos;s sandbox.</p>
      <SandboxRisks />
      {allowed ? (
        <>
          <p>Running without the sandbox is allowed for every launched browser (turn it off under Sandbox in the browser list).</p>
          <button type="button" data-variant="primary" onClick={() => { api.startBrowser(summary.name).catch(fail); }}>Start</button>
        </>
      ) : confirming ? (
        <InlineConfirm
          label="Confirm running without the sandbox"
          message="This applies to every browser code-browser launches, now and after a restart. Only allow it if you trust every page they will visit."
          confirmLabel="Allow"
          onConfirm={() => { api.setAllowUnsandboxed(true).then(() => setConfirming(false)).catch((e: Error) => onError(e.message)); }}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <button type="button" onClick={() => setConfirming(true)}>Allow without sandbox…</button>
      )}
    </section>
  );
}
