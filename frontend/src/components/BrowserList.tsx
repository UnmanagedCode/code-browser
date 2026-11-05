import { Fragment, useEffect, useRef, useState } from 'react';
import { focusInPanel } from '../focus';
import * as api from '../api';
import { statusParts } from '../browserStatus';
import { NAME_HINT } from '../names';
import type { BrowserSummary } from '../protocol';
import { NAME_RE } from '../../../src/limits.js';
import { AttachForm, type AttachDraft } from './AttachForm';
import { InlineConfirm } from './InlineConfirm';
import { RowMenu, type RowMenuItem } from './RowMenu';

// `returnFrom` is the browser the person just left, if any: its row takes focus on arrival.
interface Props { browsers: BrowserSummary[]; loading: boolean; returnFrom: string | null; onOpen(name: string): void; onError(message: string): void }

export const ALLOW_HINT = 'If Chrome asks "Allow remote debugging?", click Allow.';

type Pending = { name: string; kind: 'delete' | 'forget' | 'disallow' };

const CONFIRMS: Record<Pending['kind'], { label: string; message: (name: string) => string; confirmLabel: string }> = {
  delete: { label: 'Confirm delete', message: (n) => `Delete browser "${n}" and its logins?`, confirmLabel: 'Delete' },
  forget: { label: 'Confirm forget', message: (n) => `Forget "${n}"? code-browser disconnects and forgets it; the browser and its tabs are untouched.`, confirmLabel: 'Forget' },
  disallow: { label: 'Confirm stop and disallow', message: (n) => `Stop "${n}" now? It is running without the sandbox, and withdrawing the permission stops it.`, confirmLabel: 'Stop and disallow' },
};

export function BrowserList({ browsers, loading, returnFrom, onOpen, onError }: Props) {
  const [name, setName] = useState('');
  const [attachOpen, setAttachOpen] = useState(false);
  const [draft, setDraft] = useState<AttachDraft | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const attachButton = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const primaries = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (returnFrom === null) return;
    focusInPanel(primaries.current.get(returnFrom) ?? headingRef.current);
    // On arrival only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A start refused for want of a sandbox is not an error: the viewer explains it and offers the opt-in.
  const run = (fn: () => Promise<unknown>, refusedBrowser?: string) => fn().catch((e: Error) => {
    if (refusedBrowser !== undefined && api.isSandboxRefusal(e)) onOpen(refusedBrowser);
    else onError(e.message);
  });
  const setTrigger = (n: string) => (el: HTMLButtonElement | null) => { if (el) triggers.current.set(n, el); else triggers.current.delete(n); };
  const backToTrigger = (n: string) => triggers.current.get(n)?.focus();

  const disallow = (b: BrowserSummary) => {
    if (b.status === 'running' && b.sandbox === false) setPending({ name: b.name, kind: 'disallow' });
    else run(() => api.setAllowUnsandboxed(b.name, false));
  };
  const confirmed = (p: Pending) => {
    setPending(null);
    const call = p.kind === 'disallow' ? () => api.setAllowUnsandboxed(p.name, false) : () => api.deleteBrowser(p.name);
    run(call).finally(() => backToTrigger(p.name));
  };
  const cancelled = (p: Pending) => { setPending(null); backToTrigger(p.name); };

  const row = (b: BrowserSummary) => {
    const attached = b.kind === 'attached' && b.attached !== null;
    const stopped = b.status === 'stopped';
    const setPrimary = (el: HTMLButtonElement | null) => { if (el) primaries.current.set(b.name, el); else primaries.current.delete(b.name); };
    const primary = !stopped
      ? <button type="button" ref={setPrimary} data-size="sm" aria-label={`Open ${b.name}`} onClick={() => onOpen(b.name)}>Open</button>
      : attached
        ? <button type="button" ref={setPrimary} data-size="sm" aria-label={`Connect ${b.name}`} onClick={() => run(() => api.connectBrowser(b.name))}>Connect</button>
        : <button type="button" ref={setPrimary} data-size="sm" aria-label={`Start ${b.name}`} onClick={() => run(() => api.startBrowser(b.name), b.name)}>Start</button>;
    const items: RowMenuItem[] = [];
    if (stopped) items.push({ label: 'Open', onSelect: () => onOpen(b.name) });
    if (!stopped) items.push({ label: attached ? 'Disconnect' : 'Stop', onSelect: () => { run(() => api.stopBrowser(b.name)); } });
    if (attached) items.push({ label: 'Change…', onSelect: () => { setDraft({ name: b.name, address: b.attached!.address, via: b.attached!.via }); setAttachOpen(true); } });
    if (!attached && b.allowUnsandboxed) items.push({ label: 'Disallow without sandbox', onSelect: () => disallow(b) });
    items.push({ label: attached ? 'Forget' : 'Delete', tone: 'destructive', onSelect: () => setPending({ name: b.name, kind: attached ? 'forget' : 'delete' }) });
    const confirm = pending?.name === b.name ? pending : null;
    const parts = statusParts(b);
    return (
      <li key={b.name} className="browser-row">
        <div className="row-main">
          <strong>{b.name}</strong>
          <p className="row-status">
            {parts.map((p, i) => (
              <Fragment key={p.text}>
                {i > 0 && ' · '}
                <span data-warn={p.warn ? 'true' : undefined}>{p.text}</span>
              </Fragment>
            ))}
          </p>
        </div>
        {primary}
        <RowMenu label={`More actions for ${b.name}`} items={items} triggerRef={setTrigger(b.name)} />
        {attached && b.status === 'connecting' && <p className="row-note">{ALLOW_HINT}</p>}
        {attached && stopped && b.attachError && <p className="row-note" data-warn="true">{b.attachError}</p>}
        {confirm && (
          <InlineConfirm
            {...CONFIRMS[confirm.kind]}
            message={CONFIRMS[confirm.kind].message(b.name)}
            destructive
            onConfirm={() => confirmed(confirm)}
            onCancel={() => cancelled(confirm)}
          />
        )}
      </li>
    );
  };

  const closeAttach = () => { setDraft(null); setAttachOpen(false); };

  return (
    <main className="browser-list">
      <h1 ref={headingRef} tabIndex={-1}>Code Browser</h1>
      {loading ? (
        <p className="hint" role="status">Waiting for code-browser…</p>
      ) : (
        <>
          {browsers.length === 0 && <p className="hint">No browsers yet. Create one below, attach your own, or let the agent start one.</p>}
          <ul>{browsers.map(row)}</ul>
        </>
      )}
      <form
        className="new-browser"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => { await api.createBrowser(name); onOpen(name); setName(''); }, name);
        }}
      >
        <label htmlFor="new-browser-name">New browser name</label>
        <div className="new-browser-fields">
          <input id="new-browser-name" value={name} onChange={(e) => setName(e.target.value)} aria-describedby="new-browser-hint" title={NAME_HINT} pattern={NAME_RE.source} required />
          <button type="submit" data-variant="primary">Create</button>
        </div>
        <p id="new-browser-hint" className="hint field-hint">{NAME_HINT}</p>
      </form>
      <button
        ref={attachButton}
        type="button"
        className="attach-toggle"
        aria-expanded={attachOpen}
        onClick={() => (attachOpen ? closeAttach() : setAttachOpen(true))}
      >Attach a browser…</button>
      {attachOpen && (
        <AttachForm
          draft={draft}
          onAttached={closeAttach}
          onCancel={() => { closeAttach(); attachButton.current?.focus(); }}
          onError={onError}
        />
      )}
    </main>
  );
}
