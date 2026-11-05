import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserList } from './components/BrowserList';
import { ConnectionBanner } from './components/ConnectionBanner';
import { Toast } from './components/Toast';
import { TooltipLayer } from './components/TooltipLayer';
import { Viewer } from './components/Viewer';
import * as api from './api';
import { toToast, type ToastContent } from './errorText';
import type { BrowserState, BrowserSummary, DialogInfo } from './protocol';
import { browserFromSearch, pushBrowser } from './route';
import type { SocketStatus, ViewerSocket } from './socket';

export function App({ socket }: { socket: ViewerSocket }) {
  const [name, setName] = useState(() => browserFromSearch(location.search));
  const nameRef = useRef(name);
  nameRef.current = name;
  // Set by a route change a person made (not by the first load): the arriving view then takes focus, if the panel has it.
  const [arrival, setArrival] = useState<{ from: string | null } | null>(null);
  const [browsers, setBrowsers] = useState<BrowserSummary[]>([]);
  const [state, setState] = useState<BrowserState | null>(null);
  const [dialogs, setDialogs] = useState<DialogInfo[]>([]);
  const [toast, setToast] = useState<ToastContent | null>(null);
  const [conn, setConn] = useState<{ status: SocketStatus; failures: number }>({ status: 'connecting', failures: 0 });
  // A `browsers` list has arrived since the socket last opened. Until then the list is not known to be current,
  // and no browser is joined.
  const [synced, setSynced] = useState(false);

  const showError = useCallback((text: string) => {
    const { code, message } = api.splitCode(text);
    setToast(toToast(code, message));
  }, []);

  useEffect(() => {
    const onPop = () => {
      setArrival({ from: nameRef.current });
      setName(browserFromSearch(location.search));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => socket.onMessage((m) => {
    switch (m.type) {
      case 'browsers': setBrowsers(m.list); setSynced(true); break;
      case 'state': setState(m); break;
      case 'dialog': setDialogs((d) => [...d.filter((x) => x.tabId !== m.tabId), { tabId: m.tabId, dialogType: m.dialogType, message: m.message, defaultPrompt: m.defaultPrompt }]); break;
      case 'dialogClosed': setDialogs((d) => d.filter((x) => x.tabId !== m.tabId)); break;
      case 'error': setToast(toToast(m.code, m.message)); break;
      default:
    }
  }), [socket]);

  // A dropped socket means the list and the open dialogs are unknown: clear both. The viewer keeps its last state
  // (dimmed and inert) so the person still sees what was there; the rejoin after a fresh list replaces it.
  useEffect(() => socket.onStatus((status, failures) => {
    setConn({ status, failures });
    if (status === 'closed') {
      setSynced(false);
      setBrowsers([]);
      setDialogs([]);
    }
  }), [socket]);

  // The view follows the route, and only while a fresh list says that browser runs: a rejoin never races a backend
  // restart, and a browser that stops is un-viewed so that its next start is joined again.
  const summary = useMemo(() => browsers.find((b) => b.name === name), [browsers, name]);
  const viewable = synced && name !== null && summary?.status === 'running';
  // State and dialogs belong to one run of one browser: clear them when the route changes browser or a fresh list
  // says it stopped, but not on mount, when it starts, or on a disconnect (a reply replayed by the socket must survive).
  const lastView = useRef<{ name: string | null; viewable: boolean } | null>(null);
  useEffect(() => {
    const last = lastView.current;
    if (last && (last.name !== name || (synced && last.viewable && !viewable))) {
      setState(null);
      setDialogs([]);
    }
    if (synced || last?.name !== name) lastView.current = { name, viewable };
    socket.setView(viewable && name ? { name } : null);
  }, [socket, name, viewable, synced]);

  const open = useCallback((n: string | null) => pushBrowser(n), []);
  const shownState = state && state.name === name ? state : summary?.status === 'stopped' ? { type: 'state' as const, name: name ?? '', status: 'stopped' as const } : null;
  const offline = !synced;

  return (
    <div className="app">
      <TooltipLayer />
      <ConnectionBanner status={conn.status} failures={conn.failures} onRetry={() => socket.retry()} />
      {toast && <Toast toast={toast} onDismiss={() => setToast(null)} />}
      {name === null ? (
        <BrowserList browsers={browsers} loading={offline} returnFrom={arrival?.from ?? null} onOpen={open} onError={showError} />
      ) : (
        <Viewer
          name={name}
          socket={socket}
          state={shownState}
          dialogs={dialogs}
          summary={summary}
          offline={offline}
          focusHeading={arrival !== null}
          onError={showError}
          onBack={() => open(null)}
          onStart={() => { api.startBrowser(name).catch((e: Error) => { if (!api.isSandboxRefusal(e)) showError(e.message); }); }}
          onStop={() => { api.stopBrowser(name).catch((e: Error) => showError(e.message)); }}
          onConnect={() => { api.connectBrowser(name).catch((e: Error) => showError(e.message)); }}
        />
      )}
    </div>
  );
}
