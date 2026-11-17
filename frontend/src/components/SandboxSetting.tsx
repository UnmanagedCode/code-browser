import { useRef, useState } from 'react';
import * as api from '../api';
import type { BrowserSummary } from '../protocol';
import { InlineConfirm } from './InlineConfirm';
import { SandboxRisks } from './SandboxRisks';

interface Props { allowed: boolean; browsers: BrowserSummary[]; onError(message: string): void }

// The one plugin-wide opt-in to run launched browsers without Chromium's sandbox. Always shown, so a person can
// allow it before an agent's first refused start. Withdrawing it stops every browser running unsandboxed.
export function SandboxSetting({ allowed, browsers, onError }: Props) {
  const [confirming, setConfirming] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const unsandboxed = browsers.filter((b) => b.kind === 'launched' && b.status === 'running' && b.sandbox === false).map((b) => b.name);

  const close = () => { setConfirming(false); toggle.current?.focus(); };
  const post = (allow: boolean) => {
    setConfirming(false);
    api.setAllowUnsandboxed(allow).catch((e: Error) => onError(e.message)).finally(() => toggle.current?.focus());
  };

  return (
    <section className="sandbox-setting" aria-labelledby="sandbox-setting-title">
      <h2 id="sandbox-setting-title">Sandbox</h2>
      {allowed ? (
        <p data-warn="true">Every launched browser may run without Chromium&apos;s sandbox on this host.</p>
      ) : (
        <p>Launched browsers run only inside Chromium&apos;s sandbox. On a host without one, their starts are refused.</p>
      )}
      {confirming && !allowed && <SandboxRisks />}
      {confirming ? (
        allowed ? (
          <InlineConfirm
            label="Confirm stop and disallow"
            message={`Stop ${unsandboxed.join(', ')} now? They run without the sandbox, and withdrawing the permission stops them.`}
            confirmLabel="Stop and disallow"
            destructive
            onConfirm={() => post(false)}
            onCancel={close}
          />
        ) : (
          <InlineConfirm
            label="Confirm running without the sandbox"
            message="This applies to every browser code-browser launches, now and after a restart. Only allow it if you trust every page they will visit."
            confirmLabel="Allow"
            onConfirm={() => post(true)}
            onCancel={close}
          />
        )
      ) : allowed ? (
        <button ref={toggle} type="button" onClick={() => (unsandboxed.length > 0 ? setConfirming(true) : post(false))}>Disallow without sandbox</button>
      ) : (
        <button ref={toggle} type="button" onClick={() => setConfirming(true)}>Allow without sandbox…</button>
      )}
    </section>
  );
}
