import { useState } from 'react';
import { NAME_RE } from '../../../src/limits.js';
import * as api from '../api';
import type { BrowserSummary } from '../protocol';

interface Props { browsers: BrowserSummary[]; onOpen(name: string): void; onError(message: string): void }

export function BrowserList({ browsers, onOpen, onError }: Props) {
  const [name, setName] = useState('');
  // A start refused for want of a sandbox is not an error: the viewer explains it and offers the opt-in.
  const run = (fn: () => Promise<unknown>, refusedBrowser?: string) => fn().catch((e: Error) => {
    if (refusedBrowser !== undefined && api.isSandboxRefusal(e)) onOpen(refusedBrowser);
    else onError(e.message);
  });
  const disallow = (b: BrowserSummary) => {
    if (b.status === 'running' && b.sandbox === false && !window.confirm(`Stop "${b.name}" now? It is running without the sandbox, and withdrawing the permission stops it.`)) return;
    run(() => api.setAllowUnsandboxed(b.name, false));
  };

  return (
    <div className="browser-list">
      <h1>Browsers</h1>
      {browsers.length === 0 && <p className="hint">No browsers yet. Create one below, or let the agent start one.</p>}
      <ul>
        {browsers.map((b) => (
          <li key={b.name} className="browser-row">
            <strong>{b.name}</strong>
            <span className="badge" data-status={b.status}>{b.status}</span>
            {b.status === 'running' && <span className="badge">{b.controller === 'human' ? 'human control' : 'agent control'}</span>}
            {b.status === 'running' && b.sandbox === false && <span className="badge" data-warn="true">no sandbox</span>}
            {b.allowUnsandboxed && <span className="badge" data-warn="true">allowed without sandbox</span>}
            {b.sandboxUnavailable && !b.allowUnsandboxed && <span className="badge" data-warn="true">not started: no sandbox</span>}
            {b.status === 'stopped' && b.lastExit && <span className="badge" data-warn="true">Crashed</span>}
            <span className="spacer" />
            <button type="button" onClick={() => onOpen(b.name)}>Open</button>
            {b.status === 'stopped'
              ? <button type="button" onClick={() => run(() => api.startBrowser(b.name), b.name)}>Start</button>
              : <button type="button" onClick={() => run(() => api.stopBrowser(b.name))}>Stop</button>}
            {b.allowUnsandboxed && <button type="button" onClick={() => disallow(b)}>Disallow without sandbox</button>}
            <button
              type="button"
              onClick={() => { if (window.confirm(`Delete browser "${b.name}" and its logins?`)) run(() => api.deleteBrowser(b.name)); }}
            >Delete</button>
          </li>
        ))}
      </ul>
      <form
        className="new-browser"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => { await api.createBrowser(name); onOpen(name); setName(''); }, name);
        }}
      >
        <input aria-label="New browser name" value={name} onChange={(e) => setName(e.target.value)} placeholder="name (a-z, 0-9, -)" pattern={NAME_RE.source} required />
        <button type="submit">New browser</button>
      </form>
    </div>
  );
}
