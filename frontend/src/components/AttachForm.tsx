import { useEffect, useRef, useState } from 'react';
import proxyProtocol from '../../../proxy/protocol.json';
import { NAME_RE } from '../../../src/limits.js';
import * as api from '../api';
import { NAME_HINT } from '../names';
import type { AttachVia } from '../protocol';

export interface AttachDraft { name: string; address: string; via: AttachVia }

interface Props {
  // Set by a row's Change…: prefills the form, which then re-points that browser.
  draft: AttachDraft | null;
  onAttached(): void;
  onCancel(): void;
  onError(message: string): void;
}

const EMPTY: AttachDraft = { name: '', address: '127.0.0.1:9222', via: 'proxy' };
const DEFAULT_PORTS = proxyProtocol.defaultPorts.join(', ');

// A person attaches a browser they run themselves. Nothing here starts or launches anything: the backend
// connects to the debug port named, and the outcome arrives in the browser list.
export function AttachForm({ draft, onAttached, onCancel, onError }: Props) {
  const [form, setForm] = useState<AttachDraft>(EMPTY);
  const nameRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // Opening the form, or a row's Change…, brings it into view with the name field ready.
  useEffect(() => {
    if (draft) setForm(draft);
    formRef.current?.scrollIntoView?.({ block: 'nearest' });
    nameRef.current?.focus({ preventScroll: true });
  }, [draft]);
  const set = (patch: Partial<AttachDraft>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <form
      ref={formRef}
      className="attach-browser"
      aria-labelledby="attach-title"
      onSubmit={(e) => {
        e.preventDefault();
        api.attachBrowser(form.name, form.address, form.via).then(() => { setForm(EMPTY); onAttached(); }, (err: Error) => onError(err.message));
      }}
    >
      <h2 id="attach-title">Attach a browser</h2>
      {draft && <p className="hint">Changing &quot;{draft.name}&quot;: attaching under the same name re-points it.</p>}
      <p className="hint">Let agents use a Chrome you run yourself, with its own tabs and logins. code-browser never closes it.</p>
      <label>
        Name
        <input ref={nameRef} value={form.name} onChange={(e) => set({ name: e.target.value })} aria-describedby="attach-name-hint" title={NAME_HINT} pattern={NAME_RE.source} required />
      </label>
      <p id="attach-name-hint" className="hint field-hint">{NAME_HINT}</p>
      <label>
        Debug address
        <input value={form.address} onChange={(e) => set({ address: e.target.value })} required />
      </label>
      <p className="hint">The &quot;Server running at&quot; address on chrome://inspect/#remote-debugging, or your --remote-debugging-port.</p>
      <fieldset>
        <legend>Where the browser runs</legend>
        <label><input type="radio" name="via" checked={form.via === 'proxy'} onChange={() => set({ via: 'proxy' })} /> On the Docker host — through code-browser&apos;s proxy</label>
        <label><input type="radio" name="via" checked={form.via === 'direct'} onChange={() => set({ via: 'direct' })} /> On this machine — direct</label>
      </fieldset>
      {form.via === 'proxy' && <p className="hint">The proxy forwards only to port {DEFAULT_PORTS} unless it was started with --ports.</p>}
      <div className="form-actions">
        <button type="submit" data-variant="primary">Attach</button>
        <button type="button" data-variant="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
