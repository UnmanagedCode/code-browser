import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKOFF_MAX_MS, BACKOFF_START_MS, createViewerSocket } from './socket';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = '';
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  drop() { this.readyState = 3; this.onclose?.(); }
}

function fakeDoc() {
  const listeners = new Set<() => void>();
  return {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    setVisibility(v: DocumentVisibilityState) { this.visibilityState = v; listeners.forEach((fn) => fn()); },
  };
}

let doc: ReturnType<typeof fakeDoc>;
const make = () => createViewerSocket({ url: 'ws://x/api/ws', viewerId: 'viewer-123456', createSocket: (u) => new FakeWebSocket(u) as unknown as WebSocket, doc: doc as unknown as Document });
const last = () => FakeWebSocket.instances.at(-1)!;

beforeEach(() => { vi.useFakeTimers(); FakeWebSocket.instances = []; doc = fakeDoc(); });
afterEach(() => { vi.useRealTimers(); });

describe('viewer socket', () => {
  // Invariant: every open says hello first, then the current view.
  it('sends hello then the view on open', () => {
    const s = make();
    s.setView({ name: 'a', maxWidth: 800, maxHeight: 600 });
    expect(last().sent).toEqual([]);
    last().open();
    expect(last().sent).toEqual([{ msg: 'hello', viewerId: 'viewer-123456' }, { msg: 'view', name: 'a', maxWidth: 800, maxHeight: 600 }]);
  });

  // Invariant: reconnect uses exponential backoff capped at the maximum, and a successful open resets it.
  it('reconnects with growing, capped backoff that resets after an open', () => {
    make();
    const gaps: number[] = [];
    for (let i = 0; i < 8; i++) {
      const n = FakeWebSocket.instances.length;
      last().drop();
      let waited = 0;
      while (FakeWebSocket.instances.length === n) { vi.advanceTimersByTime(50); waited += 50; }
      gaps.push(waited);
    }
    expect(gaps[0]).toBe(BACKOFF_START_MS);
    expect(gaps[1]).toBe(BACKOFF_START_MS * 2);
    expect(gaps[2]).toBe(BACKOFF_START_MS * 4);
    expect(Math.max(...gaps)).toBe(BACKOFF_MAX_MS);
    expect(gaps.at(-1)).toBe(BACKOFF_MAX_MS);
    last().open();
    const n = FakeWebSocket.instances.length;
    last().drop();
    vi.advanceTimersByTime(BACKOFF_START_MS);
    expect(FakeWebSocket.instances.length).toBe(n + 1);
  });

  // Invariant: after a reconnect the new socket says hello again and re-joins the same view.
  it('re-hellos and re-views on reconnect', () => {
    const s = make();
    s.setView({ name: 'a', maxWidth: 1, maxHeight: 2 });
    last().open();
    last().drop();
    vi.advanceTimersByTime(BACKOFF_START_MS);
    last().open();
    expect(last().sent).toEqual([{ msg: 'hello', viewerId: 'viewer-123456' }, { msg: 'view', name: 'a', maxWidth: 1, maxHeight: 2 }]);
  });

  // Invariant: a hidden page pauses its view (so the host stops screencasting for it) and resumes it when visible.
  it('pauses the view while hidden and resumes when visible', () => {
    const s = make();
    s.setView({ name: 'a', maxWidth: 1, maxHeight: 2 });
    last().open();
    doc.setVisibility('hidden');
    doc.setVisibility('visible');
    expect(last().sent.slice(2)).toEqual([{ msg: 'view', name: null, maxWidth: 0, maxHeight: 0 }, { msg: 'view', name: 'a', maxWidth: 1, maxHeight: 2 }]);
  });

  // Invariant: a view set while hidden is not sent until the page is visible.
  it('does not join a view while hidden', () => {
    const s = make();
    last().open();
    doc.setVisibility('hidden');
    s.setView({ name: 'a', maxWidth: 1, maxHeight: 2 });
    expect(last().sent).toEqual([{ msg: 'hello', viewerId: 'viewer-123456' }]);
    doc.setVisibility('visible');
    expect(last().sent.at(-1)).toMatchObject({ msg: 'view', name: 'a' });
  });

  // Invariant: setting the same view twice joins once; changing to null leaves.
  it('deduplicates identical views', () => {
    const s = make();
    last().open();
    s.setView({ name: 'a', maxWidth: 1, maxHeight: 2 });
    s.setView({ name: 'a', maxWidth: 1, maxHeight: 2 });
    s.setView(null);
    expect(last().sent.filter((m) => (m as { msg: string }).msg === 'view')).toHaveLength(2);
  });

  // Invariant: resizes send `viewport` (never a re-join) and are remembered for the next reconnect.
  it('viewport is sent while viewing and remembered across reconnects', () => {
    const s = make();
    s.setView({ name: 'a', maxWidth: 1, maxHeight: 2 });
    last().open();
    s.setViewport(300, 400);
    expect(last().sent.at(-1)).toEqual({ msg: 'viewport', maxWidth: 300, maxHeight: 400 });
    last().drop();
    vi.advanceTimersByTime(BACKOFF_START_MS);
    last().open();
    expect(last().sent.at(-1)).toEqual({ msg: 'view', name: 'a', maxWidth: 300, maxHeight: 400 });
  });

  // Invariant: send reports whether the message went out; nothing is queued while closed.
  it('send returns false and drops messages while not open', () => {
    const s = make();
    expect(s.send({ msg: 'ack', seq: 1 })).toBe(false);
    last().open();
    expect(s.send({ msg: 'ack', seq: 2 })).toBe(true);
    expect(last().sent.filter((m) => (m as { msg: string }).msg === 'ack')).toEqual([{ msg: 'ack', seq: 2 }]);
  });

  // Invariant: text frames are parsed as messages; binary frames are decoded as screencast frames.
  it('dispatches JSON messages and binary frames', () => {
    const s = make();
    const messages: unknown[] = [];
    const frames: unknown[] = [];
    s.onMessage((m) => messages.push(m));
    s.onFrame((h, j) => frames.push([h.seq, j.length]));
    last().open();
    last().onmessage?.({ data: JSON.stringify({ type: 'error', code: 'X', message: 'm' }) });
    const head = new TextEncoder().encode(JSON.stringify({ seq: 4, tabId: 't', width: 1, height: 1, meta: {} }));
    const buf = new Uint8Array(4 + head.length + 3);
    new DataView(buf.buffer).setUint32(0, head.length);
    buf.set(head, 4);
    last().onmessage?.({ data: buf.buffer });
    expect(messages).toEqual([{ type: 'error', code: 'X', message: 'm' }]);
    expect(frames).toEqual([[4, 3]]);
  });

  const frameBuffer = (seq: number) => {
    const head = new TextEncoder().encode(JSON.stringify({ seq, tabId: 't', width: 1, height: 1, meta: {} }));
    const buf = new Uint8Array(4 + head.length + 1);
    new DataView(buf.buffer).setUint32(0, head.length);
    buf.set(head, 4);
    return buf.buffer;
  };

  // Invariant: a frame that arrives before anything subscribed (the screen mounts just after `state`) is delivered
  // once to the first subscriber, so it is drawn and acked instead of leaving the backend waiting forever.
  it('holds a frame that arrives with no subscriber and delivers it once', () => {
    const s = make();
    last().open();
    last().onmessage?.({ data: frameBuffer(1) });
    last().onmessage?.({ data: frameBuffer(2) });
    const seen: number[] = [];
    s.onFrame((h) => seen.push(h.seq))();
    s.onFrame((h) => seen.push(h.seq));
    expect(seen).toEqual([2]);
  });

  // Invariant: with a subscriber present frames are delivered directly and never held.
  it('does not hold frames while subscribed', () => {
    const s = make();
    last().open();
    const seen: number[] = [];
    const off = s.onFrame((h) => seen.push(h.seq));
    last().onmessage?.({ data: frameBuffer(1) });
    off();
    s.onFrame((h) => seen.push(h.seq));
    expect(seen).toEqual([1]);
  });

  // Invariant: a held frame of a previous browser is discarded when the view changes.
  it('drops a held frame when the viewed browser changes', () => {
    const s = make();
    s.setView({ name: 'a', maxWidth: 0, maxHeight: 0 });
    last().open();
    last().onmessage?.({ data: frameBuffer(1) });
    s.setView({ name: 'b', maxWidth: 0, maxHeight: 0 });
    const seen: number[] = [];
    s.onFrame((h) => seen.push(h.seq));
    expect(seen).toEqual([]);
  });

  const deliver = (m: unknown) => last().onmessage?.({ data: JSON.stringify(m) });
  const tabState = (name: string, v: number) => ({ type: 'state', name, status: 'running', tabs: [{ targetId: `T${v}`, url: '', title: '' }] });

  // Invariant: control messages that arrive before anything subscribed (the reply to hello can beat App's effect)
  // are kept, coalesced to what a late subscriber needs: latest browsers, latest state per browser, open dialogs, latest error.
  it('replays the held messages to the first subscriber, coalesced, once', () => {
    const s = make();
    last().open();
    deliver({ type: 'browsers', list: [{ name: 'old' }] });
    deliver({ type: 'browsers', list: [{ name: 'a' }] });
    deliver(tabState('a', 1));
    deliver(tabState('a', 2));
    deliver(tabState('b', 3));
    deliver({ type: 'dialog', tabId: 'd1', dialogType: 'alert', message: 'one', defaultPrompt: '' });
    deliver({ type: 'dialog', tabId: 'd2', dialogType: 'alert', message: 'two', defaultPrompt: '' });
    deliver({ type: 'dialogClosed', tabId: 'd2' });
    deliver({ type: 'error', code: 'X', message: 'first' });
    deliver({ type: 'error', code: 'Y', message: 'second' });
    const seen: unknown[] = [];
    s.onMessage((m) => seen.push(m))();
    const second: unknown[] = [];
    s.onMessage((m) => second.push(m));
    expect(seen.map((m) => JSON.stringify(m))).toEqual([
      JSON.stringify({ type: 'browsers', list: [{ name: 'a' }] }),
      JSON.stringify(tabState('a', 2)),
      JSON.stringify(tabState('b', 3)),
      JSON.stringify({ type: 'dialog', tabId: 'd1', dialogType: 'alert', message: 'one', defaultPrompt: '' }),
      JSON.stringify({ type: 'error', code: 'Y', message: 'second' }),
    ]);
    expect(second).toEqual([]);
  });

  // Invariant: with a subscriber present messages go straight to it and nothing is held for later.
  it('does not hold messages while subscribed', () => {
    const s = make();
    last().open();
    const seen: unknown[] = [];
    const off = s.onMessage((m) => seen.push(m));
    deliver({ type: 'browsers', list: [] });
    off();
    const later: unknown[] = [];
    s.onMessage((m) => later.push(m));
    expect(seen).toHaveLength(1);
    expect(later).toEqual([]);
  });

  // Invariant: held browser state and dialogs belong to the viewed browser and are dropped when the view changes;
  // the browser list is not tied to a view and stays.
  it('drops held state and dialogs, but not the list, when the viewed browser changes', () => {
    const s = make();
    s.setView({ name: 'a', maxWidth: 0, maxHeight: 0 });
    last().open();
    deliver({ type: 'browsers', list: [] });
    deliver(tabState('a', 1));
    deliver({ type: 'dialog', tabId: 'd1', dialogType: 'alert', message: 'm', defaultPrompt: '' });
    s.setView({ name: 'b', maxWidth: 0, maxHeight: 0 });
    const seen: { type: string }[] = [];
    s.onMessage((m) => seen.push(m));
    expect(seen.map((m) => m.type)).toEqual(['browsers']);
  });

  // Invariant: close() stops reconnecting.
  it('close stops reconnection', () => {
    const s = make();
    last().open();
    s.close();
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
