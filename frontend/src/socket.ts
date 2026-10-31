import { decodeFrame } from './frame';
import type { ClientMessage, FrameHeader, ServerMessage } from './protocol';

export type SocketStatus = 'connecting' | 'open' | 'closed';
export interface View { name: string; maxWidth: number; maxHeight: number }

export interface ViewerSocket {
  send(msg: ClientMessage): boolean;
  setView(view: View | null): void;
  setViewport(maxWidth: number, maxHeight: number): void;
  onMessage(fn: (m: ServerMessage) => void): () => void;
  onFrame(fn: (header: FrameHeader, jpeg: Uint8Array) => void): () => void;
  onStatus(fn: (s: SocketStatus) => void): () => void;
  close(): void;
}

export interface SocketOptions {
  url: string;
  viewerId: string;
  createSocket?: (url: string) => WebSocket;
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
}

export const BACKOFF_START_MS = 500;
export const BACKOFF_MAX_MS = 10_000;

// One socket per panel page. Reconnects with backoff and, on every open, says hello and re-sends the view.
// While the page is hidden the view is paused (view null), so a backgrounded tab costs the host nothing.
export function createViewerSocket({ url, viewerId, createSocket = (u) => new WebSocket(u), doc = document }: SocketOptions): ViewerSocket {
  const messageFns = new Set<(m: ServerMessage) => void>();
  const frameFns = new Set<(h: FrameHeader, j: Uint8Array) => void>();
  const statusFns = new Set<(s: SocketStatus) => void>();
  let ws: WebSocket | null = null;
  let desired: View | null = null;
  let sentName: string | null = null; // the server starts a connection with no view
  let backoff = BACKOFF_START_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  // A frame that arrives while nothing is subscribed (the screen has not mounted yet: a late joiner's cached
  // frame comes right after `state`) is held for the next subscriber. Dropping it would leave it un-acked,
  // and the backend sends no further frame to a viewer with one in flight.
  let held: { header: FrameHeader; jpeg: Uint8Array } | null = null;

  const status = (s: SocketStatus) => statusFns.forEach((fn) => fn(s));
  const isOpen = () => ws !== null && ws.readyState === 1;
  const rawSend = (msg: ClientMessage) => { if (isOpen()) ws!.send(JSON.stringify(msg)); return isOpen(); };
  const effective = (): View | null => (doc.visibilityState === 'hidden' ? null : desired);

  function syncView() {
    if (!isOpen()) return;
    const v = effective();
    const name = v ? v.name : null;
    if (name === sentName) return;
    sentName = name;
    rawSend({ msg: 'view', name, maxWidth: v?.maxWidth ?? 0, maxHeight: v?.maxHeight ?? 0 });
  }

  function connect() {
    status('connecting');
    ws = createSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      backoff = BACKOFF_START_MS;
      sentName = null;
      status('open');
      rawSend({ msg: 'hello', viewerId });
      syncView();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data) as ServerMessage;
        messageFns.forEach((fn) => fn(msg));
      } else {
        const { header, jpeg } = decodeFrame(ev.data as ArrayBuffer);
        if (frameFns.size === 0) held = { header, jpeg };
        else frameFns.forEach((fn) => fn(header, jpeg));
      }
    };
    ws.onclose = () => {
      ws = null;
      status('closed');
      if (closed) return;
      timer = setTimeout(connect, backoff);
      backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
    };
  }

  const onVisibility = () => syncView();
  doc.addEventListener('visibilitychange', onVisibility);
  connect();

  const subscribe = <T>(set: Set<T>, fn: T) => { set.add(fn); return () => { set.delete(fn); }; };
  return {
    send: rawSend,
    setView(view) {
      if ((view?.name ?? null) !== (desired?.name ?? null)) held = null; // a frame of the previous browser is stale
      desired = view;
      syncView();
    },
    setViewport(maxWidth, maxHeight) {
      if (!desired) return;
      desired = { ...desired, maxWidth, maxHeight };
      if (effective()) rawSend({ msg: 'viewport', maxWidth, maxHeight });
    },
    onMessage: (fn) => subscribe(messageFns, fn),
    onFrame(fn) {
      const off = subscribe(frameFns, fn);
      if (held) {
        const { header, jpeg } = held;
        held = null;
        fn(header, jpeg);
      }
      return off;
    },
    onStatus: (fn) => subscribe(statusFns, fn),
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      doc.removeEventListener('visibilitychange', onVisibility);
      ws?.close();
    },
  };
}
