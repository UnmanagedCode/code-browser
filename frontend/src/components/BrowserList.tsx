import { useState } from 'react';
import { NAME_RE } from '../../../src/limits.js';
import * as api from '../api';
import type { BrowserSummary } from '../protocol';

interface Props { browsers: BrowserSummary[]; onOpen(name: string): void; onError(message: string): void }

export function BrowserList({ browsers, onOpen, onError }: Props) {
  const [name, setName] = useState('');
  const run = (fn: () => Promise<unknown>) => fn().catch((e: Error) => onError(e.message));

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
            {b.status === 'stopped' && b.lastExit && <span className="badge" data-warn="true">Crashed</span>}
            <span className="spacer" />
            <button type="button" onClick={() => onOpen(b.name)}>Open</button>
            {b.status === 'stopped'
              ? <button type="button" onClick={() => run(() => api.startBrowser(b.name))}>Start</button>
              : <button type="button" onClick={() => run(() => api.stopBrowser(b.name))}>Stop</button>}
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
          run(async () => { await api.createBrowser(name); onOpen(name); setName(''); });
        }}
      >
        <input aria-label="New browser name" value={name} onChange={(e) => setName(e.target.value)} placeholder="name (a-z, 0-9, -)" pattern={NAME_RE.source} required />
        <button type="submit">New browser</button>
      </form>
    </div>
  );
}
