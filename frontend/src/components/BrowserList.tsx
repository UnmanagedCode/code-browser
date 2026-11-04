import { useState } from 'react';
import { NAME_RE } from '../../../src/limits.js';
import * as api from '../api';
import type { BrowserSummary } from '../protocol';
import { AttachForm, type AttachDraft } from './AttachForm';

interface Props { browsers: BrowserSummary[]; onOpen(name: string): void; onError(message: string): void }

export const ALLOW_HINT = 'If Chrome asks "Allow remote debugging?", click Allow.';

export function BrowserList({ browsers, onOpen, onError }: Props) {
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<AttachDraft | null>(null);
  // A start refused for want of a sandbox is not an error: the viewer explains it and offers the opt-in.
  const run = (fn: () => Promise<unknown>, refusedBrowser?: string) => fn().catch((e: Error) => {
    if (refusedBrowser !== undefined && api.isSandboxRefusal(e)) onOpen(refusedBrowser);
    else onError(e.message);
  });
  const disallow = (b: BrowserSummary) => {
    if (b.status === 'running' && b.sandbox === false && !window.confirm(`Stop "${b.name}" now? It is running without the sandbox, and withdrawing the permission stops it.`)) return;
    run(() => api.setAllowUnsandboxed(b.name, false));
  };

  const launchedRow = (b: BrowserSummary) => (
    <li key={b.name} className="browser-row">
      <strong>{b.name}</strong>
      <span className="badge" data-status={b.status}>{b.status}</span>
      {b.status === 'running' && <span className="badge">{b.controller === 'human' ? 'human control' : 'agent control'}</span>}
      {b.status === 'running' && b.sandbox === false && <span className="badge" data-warn="true">no sandbox</span>}
      {b.allowUnsandboxed && <span className="badge" data-warn="true">allowed without sandbox</span>}
      {b.sandboxUnavailable && !b.allowUnsandboxed && <span className="badge" data-warn="true">not started: no sandbox</span>}
      {b.status === 'stopped' && b.lastExit && <span className="badge" data-warn="true">Crashed</span>}
      <span className="spacer" />
      <button type="button" data-size="sm" onClick={() => onOpen(b.name)}>Open</button>
      {b.status === 'stopped'
        ? <button type="button" data-size="sm" onClick={() => run(() => api.startBrowser(b.name), b.name)}>Start</button>
        : <button type="button" data-size="sm" onClick={() => run(() => api.stopBrowser(b.name))}>Stop</button>}
      {b.allowUnsandboxed && <button type="button" data-size="sm" onClick={() => disallow(b)}>Disallow without sandbox</button>}
      <button
        type="button"
        data-variant="destructive"
        data-size="sm"
        onClick={() => { if (window.confirm(`Delete browser "${b.name}" and its logins?`)) run(() => api.deleteBrowser(b.name)); }}
      >Delete</button>
    </li>
  );

  // A person's own browser: code-browser only connects to it and disconnects; it never stops or closes it.
  const attachedRow = (b: BrowserSummary) => {
    const a = b.attached!;
    return (
      <li key={b.name} className="browser-row">
        <strong>{b.name}</strong>
        <span className="badge" data-status={b.status}>{b.status}</span>
        <span className="badge">attached</span>
        <span className="badge">{a.via === 'proxy' ? 'via proxy' : 'direct'}</span>
        <span className="hint">{a.address}</span>
        {a.asksApproval && <span className="badge">asks approval</span>}
        {b.status === 'running' && <span className="badge">{b.controller === 'human' ? 'human control' : 'agent control'}</span>}
        {b.status === 'stopped' && b.lastExit && <span className="badge" data-warn="true">Disconnected</span>}
        <span className="spacer" />
        <button type="button" data-size="sm" onClick={() => onOpen(b.name)}>Open</button>
        {b.status === 'stopped'
          ? <button type="button" data-size="sm" onClick={() => run(() => api.connectBrowser(b.name))}>Connect</button>
          : <button type="button" data-size="sm" onClick={() => run(() => api.stopBrowser(b.name))}>Disconnect</button>}
        <button type="button" data-size="sm" onClick={() => setDraft({ name: b.name, address: a.address, via: a.via })}>Change…</button>
        <button
          type="button"
          data-variant="destructive"
          data-size="sm"
          onClick={() => {
            if (window.confirm(`Forget "${b.name}"? code-browser disconnects and forgets it; the browser and its tabs are untouched.`)) run(() => api.deleteBrowser(b.name));
          }}
        >Forget</button>
        {b.status === 'connecting' && <p className="row-note">{ALLOW_HINT}</p>}
        {b.status === 'stopped' && b.attachError && <p className="row-note" data-warn="true">{b.attachError}</p>}
      </li>
    );
  };

  return (
    <div className="browser-list">
      <h1>Code Browser</h1>
      {browsers.length === 0 && <p className="hint">No browsers yet. Create one below, or let the agent start one.</p>}
      <ul>
        {browsers.map((b) => (b.kind === 'attached' && b.attached ? attachedRow(b) : launchedRow(b)))}
      </ul>
      <form
        className="new-browser"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => { await api.createBrowser(name); onOpen(name); setName(''); }, name);
        }}
      >
        <input aria-label="New browser name" value={name} onChange={(e) => setName(e.target.value)} placeholder="name (a-z, 0-9, -)" pattern={NAME_RE.source} required />
        <button type="submit" data-variant="primary">New browser</button>
      </form>
      <AttachForm draft={draft} onAttached={() => setDraft(null)} onError={onError} />
    </div>
  );
}
