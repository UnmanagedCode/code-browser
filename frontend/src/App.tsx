import { useCallback, useEffect, useMemo, useState } from 'react';
import { BrowserList } from './components/BrowserList';
import { Viewer } from './components/Viewer';
import * as api from './api';
import type { BrowserState, BrowserSummary, DialogInfo } from './protocol';
import { browserFromSearch, pushBrowser } from './route';
import type { ViewerSocket } from './socket';

export function App({ socket }: { socket: ViewerSocket }) {
  const [name, setName] = useState(() => browserFromSearch(location.search));
  const [browsers, setBrowsers] = useState<BrowserSummary[]>([]);
  const [state, setState] = useState<BrowserState | null>(null);
  const [dialogs, setDialogs] = useState<DialogInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onPop = () => setName(browserFromSearch(location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => socket.onMessage((m) => {
    switch (m.type) {
      case 'browsers': setBrowsers(m.list); break;
      case 'state': setState(m); break;
      case 'dialog': setDialogs((d) => [...d.filter((x) => x.tabId !== m.tabId), { tabId: m.tabId, dialogType: m.dialogType, message: m.message, defaultPrompt: m.defaultPrompt }]); break;
      case 'dialogClosed': setDialogs((d) => d.filter((x) => x.tabId !== m.tabId)); break;
      case 'error': setError(`${m.code}: ${m.message}`); break;
      default:
    }
  }), [socket]);

  // The view follows the route, and only while that browser runs; a browser that stops is un-viewed
  // so that its next start is joined again.
  const summary = useMemo(() => browsers.find((b) => b.name === name), [browsers, name]);
  const viewable = name !== null && summary?.status === 'running';
  useEffect(() => {
    setState(null);
    setDialogs([]);
    socket.setView(viewable && name ? { name, maxWidth: 0, maxHeight: 0 } : null);
  }, [socket, name, viewable]);

  const open = useCallback((n: string | null) => pushBrowser(n), []);
  const shownState = state && state.name === name ? state : summary?.status === 'stopped' ? { type: 'state' as const, name: name ?? '', status: 'stopped' as const } : null;

  return (
    <>
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setError(null)}>×</button>
        </div>
      )}
      {name === null ? (
        <BrowserList browsers={browsers} onOpen={open} onError={setError} />
      ) : (
        <Viewer
          name={name}
          socket={socket}
          state={shownState}
          dialogs={dialogs}
          onBack={() => open(null)}
          onStart={() => { api.startBrowser(name).catch((e: Error) => setError(e.message)); }}
        />
      )}
    </>
  );
}
