import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { BrowserState, BrowserSummary, ClientMessage, FrameHeader, ServerMessage } from './protocol';
import { createViewerSocket, type SocketStatus, type ViewerSocket, type View } from './socket';

function fakeSocket() {
  const msgFns = new Set<(m: ServerMessage) => void>();
  const frameFns = new Set<(h: FrameHeader, j: Uint8Array) => void>();
  const sent: ClientMessage[] = [];
  const views: (View | null)[] = [];
  const socket: ViewerSocket = {
    send: (m) => { sent.push(m); return true; },
    setView: (v) => { views.push(v); },
    setViewport: () => {},
    onMessage: (fn) => { msgFns.add(fn); return () => { msgFns.delete(fn); }; },
    onFrame: (fn) => { frameFns.add(fn); return () => { frameFns.delete(fn); }; },
    onStatus: (fn: (s: SocketStatus) => void) => { void fn; return () => {}; },
    close: () => {},
  };
  return {
    socket, sent, views,
    emit: (m: ServerMessage) => act(() => { msgFns.forEach((fn) => fn(m)); }),
    frame: (h: FrameHeader) => act(async () => { frameFns.forEach((fn) => fn(h, new Uint8Array([1]))); await Promise.resolve(); await Promise.resolve(); }),
    inputs: () => sent.filter((m) => m.msg === 'input'),
  };
}

const running = (name: string, controller: BrowserSummary['controller'] = 'agent'): BrowserSummary => ({ name, status: 'running', controller, sandbox: true, allowUnsandboxed: false, sandboxUnavailable: false, lastExit: null });
const state = (over: Partial<BrowserState> = {}): BrowserState => ({
  type: 'state', name: 'a', status: 'running', sandbox: true, controller: { kind: 'agent' },
  tabs: [{ targetId: 'T1', url: 'https://one.test/', title: 'One' }], activeTabId: 'T1', canGoBack: false, canGoForward: false, ...over,
});
const goTo = (search: string) => history.replaceState(null, '', search || location.pathname);

let f: ReturnType<typeof fakeSocket>;
beforeEach(() => {
  f = fakeSocket();
  goTo('?browser=a');
  vi.stubGlobal('createImageBitmap', async () => ({ width: 200, height: 100, close() {} }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); goTo(''); });

async function openViewer(controller: BrowserState['controller'] = { kind: 'agent' }) {
  render(<App socket={f.socket} />);
  await f.emit({ type: 'browsers', list: [running('a', controller?.kind === 'human' ? 'human' : 'agent')] });
  await f.emit(state({ controller }));
}

describe('App routing', () => {
  // Invariant: `?browser=<name>` opens that browser's viewer and joins its view; without it the list shows.
  it('?browser= selects the viewer and joins the view; no param shows the list', async () => {
    await openViewer();
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(f.views.at(-1)).toMatchObject({ name: 'a' });
    expect(screen.queryByRole('heading', { name: 'Code Browser' })).toBeNull();
  });

  it('shows the browser list when no browser is selected', async () => {
    goTo('');
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [running('a'), { ...running('b'), status: 'stopped', controller: 'agent', lastExit: { code: null, signal: 'SIGSEGV', at: 1 } }] });
    expect(screen.getByRole('heading', { name: 'Code Browser' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(2);
    expect(screen.getByText('Crashed')).toBeTruthy();
    expect(f.views.at(-1)).toBeNull();
  });

  // Invariant: a browser that is not running is not joined; its Start button is offered instead.
  it('a stopped browser is not joined and offers Start', async () => {
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [{ ...running('a'), status: 'stopped' }] });
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy();
    expect(f.views.at(-1)).toBeNull();
  });
});

describe('page-controlled text', () => {
  // Invariant: a tab title is rendered as literal text and never parsed as markup.
  it('a hostile tab title becomes text, not an element', async () => {
    const title = '<img src=x onerror="window.__pwned=1">';
    await openViewer();
    await f.emit(state({ tabs: [{ targetId: 'T1', url: 'https://one.test/', title }] }));
    expect(screen.getByRole('tab', { name: title }).textContent).toBe(title);
    expect(document.querySelector('img')).toBeNull();
  });

  // Invariant: a dialog message is rendered as literal text.
  it('a hostile dialog message becomes text', async () => {
    await openViewer({ kind: 'human', you: true });
    await f.emit({ type: 'dialog', tabId: 'T1', dialogType: 'alert', message: '<b id="x">bold</b>', defaultPrompt: '' });
    expect(screen.getByRole('dialog').textContent).toContain('<b id="x">bold</b>');
    expect(document.querySelector('#x')).toBeNull();
  });
});

describe('controller bar', () => {
  // Invariant: the three control states show the right actions, and the actions send control messages.
  it('agent state offers Take control, which sends take', async () => {
    await openViewer({ kind: 'agent' });
    expect(screen.getByText('Agent has control')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Hand back' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
    expect(f.sent).toContainEqual({ msg: 'control', action: 'take' });
  });

  it('own control offers Hand back, which sends release', async () => {
    await openViewer({ kind: 'human', you: true });
    expect(screen.getByText('You have control')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Take control' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Hand back' }));
    expect(f.sent).toContainEqual({ msg: 'control', action: 'release' });
  });

  it("another viewer's control offers Take control", async () => {
    await openViewer({ kind: 'human', you: false });
    expect(screen.getByText('Another viewer has control')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Take control' })).toBeTruthy();
  });

  // Invariant: actions that need control are disabled without it, and enabled with it.
  it('tab close/new and navigation need control', async () => {
    await openViewer({ kind: 'agent' });
    for (const name of ['New tab', 'Close tab One', 'Reload', 'Show keyboard']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled, name).toBe(true);
    }
    expect((screen.getByRole('textbox', { name: 'Address' }) as HTMLInputElement).readOnly).toBe(true);
    await f.emit(state({ controller: { kind: 'human', you: true } }));
    for (const name of ['New tab', 'Close tab One', 'Reload', 'Show keyboard']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled, name).toBe(false);
    }
  });

  // Invariant: switching the viewed tab needs no control.
  it('selecting a tab sends activate without control', async () => {
    await openViewer({ kind: 'agent' });
    await f.emit(state({ tabs: [{ targetId: 'T1', url: 'a', title: 'One' }, { targetId: 'T2', url: 'b', title: 'Two' }] }));
    fireEvent.click(screen.getByRole('tab', { name: 'Two' }));
    expect(f.sent).toContainEqual({ msg: 'tab', action: 'activate', tabId: 'T2' });
    expect(screen.getByRole('tab', { name: 'One' }).getAttribute('aria-selected')).toBe('true');
  });

  // Invariant: the address bar navigates with the typed text on Enter.
  it('the address bar sends goto on submit', async () => {
    await openViewer({ kind: 'human', you: true });
    const input = screen.getByRole('textbox', { name: 'Address' });
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.submit(input.closest('form')!);
    expect(f.sent).toContainEqual({ msg: 'nav', action: 'goto', url: 'example.com' });
  });
});

describe('pointer input', () => {
  const header: FrameHeader = { seq: 1, tabId: 'T1', width: 200, height: 100, meta: { deviceWidth: 1000, deviceHeight: 500, offsetTop: 0, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0 } };
  const canvas = () => screen.getByLabelText('Browser screen');

  // Invariant: a drawn frame is acked (this paces the backend), and exposes its sequence for observers.
  it('draws a frame, acks it and records its sequence', async () => {
    await openViewer();
    await f.frame(header);
    await waitFor(() => expect(f.sent).toContainEqual({ msg: 'ack', seq: 1 }));
    expect(canvas().dataset.frameSeq).toBe('1');
  });

  // Invariant: without control a click sends no input; with control it sends mouse messages in page pixels.
  it('without control pointer events send nothing; with control they send mapped mouse messages', async () => {
    await openViewer({ kind: 'agent' });
    await f.frame(header);
    fireEvent.pointerDown(canvas(), { clientX: 100, clientY: 50, pointerType: 'mouse', pointerId: 1, button: 0, buttons: 1 });
    fireEvent.pointerUp(canvas(), { clientX: 100, clientY: 50, pointerType: 'mouse', pointerId: 1, button: 0, buttons: 0 });
    expect(f.inputs()).toEqual([]);
    expect(screen.getByText('Take control to interact')).toBeTruthy();

    await f.emit(state({ controller: { kind: 'human', you: true } }));
    expect(screen.queryByText('Take control to interact')).toBeNull();
    fireEvent.pointerDown(canvas(), { clientX: 100, clientY: 50, pointerType: 'mouse', pointerId: 1, button: 0, buttons: 1 });
    fireEvent.pointerUp(canvas(), { clientX: 100, clientY: 50, pointerType: 'mouse', pointerId: 1, button: 0, buttons: 0 });
    expect(f.inputs()).toMatchObject([
      { kind: 'mouse', action: 'down', x: 500, y: 250, button: 'left', clickCount: 1 },
      { kind: 'mouse', action: 'up', x: 500, y: 250, button: 'left' },
    ]);
  });

  // Invariant: a touch tap becomes a left click (move, down, up), mapped like the mouse.
  it('a touch tap becomes a click', async () => {
    await openViewer({ kind: 'human', you: true });
    await f.frame(header);
    fireEvent.pointerDown(canvas(), { clientX: 20, clientY: 10, pointerType: 'touch', pointerId: 5 });
    fireEvent.pointerUp(canvas(), { clientX: 20, clientY: 10, pointerType: 'touch', pointerId: 5 });
    expect(f.inputs().map((m) => (m as { action?: string }).action)).toEqual(['move', 'down', 'up']);
    expect(f.inputs()[1]).toMatchObject({ x: 100, y: 50, button: 'left', clickCount: 1 });
  });

  // Invariant: a click on the letterbox bars (outside the image) sends nothing.
  it('a point outside the frame is dropped', async () => {
    await openViewer({ kind: 'human', you: true });
    await f.frame(header);
    // The 200x100 image in a 200x400 box leaves 150px letterbox bars above and below.
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 400, right: 200, bottom: 400, x: 0, y: 0, toJSON() {} });
    fireEvent.pointerDown(canvas(), { clientX: 100, clientY: 5, pointerType: 'mouse', pointerId: 1, button: 0, buttons: 1 });
    expect(f.inputs()).toEqual([]);
  });
});

describe('dialogs', () => {
  // Invariant: OK on a dialog sends accept for that tab; Cancel sends dismiss; both need control.
  it('OK sends accept; answering needs control', async () => {
    await openViewer({ kind: 'agent' });
    await f.emit({ type: 'dialog', tabId: 'T1', dialogType: 'confirm', message: 'sure?', defaultPrompt: '' });
    expect((screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(true);
    await f.emit(state({ controller: { kind: 'human', you: true } }));
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(f.sent).toContainEqual({ msg: 'dialog', tabId: 'T1', action: 'accept' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(f.sent).toContainEqual({ msg: 'dialog', tabId: 'T1', action: 'dismiss' });
  });

  // Invariant: a viewer without control can take it from the dialog itself (the backdrop covers the controller bar).
  it('the dialog offers Take control when the viewer lacks it', async () => {
    await openViewer({ kind: 'agent' });
    await f.emit({ type: 'dialog', tabId: 'T1', dialogType: 'alert', message: 'hi', defaultPrompt: '' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Take control' }));
    expect(f.sent).toContainEqual({ msg: 'control', action: 'take' });
  });

  it('a prompt sends its text with accept, and dialogClosed removes it', async () => {
    await openViewer({ kind: 'human', you: true });
    await f.emit({ type: 'dialog', tabId: 'T1', dialogType: 'prompt', message: 'name?', defaultPrompt: 'x' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt answer' }), { target: { value: 'bob' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(f.sent).toContainEqual({ msg: 'dialog', tabId: 'T1', action: 'accept', promptText: 'bob' });
    await f.emit({ type: 'dialogClosed', tabId: 'T1' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('errors and the list', () => {
  // Invariant: a server error is shown to the user, not swallowed.
  it('shows server errors in an alert', async () => {
    await openViewer();
    await f.emit({ type: 'error', code: 'NOT_CONTROLLER', message: 'take control first' });
    expect(screen.getByRole('alert').textContent).toContain('NOT_CONTROLLER');
  });

  // Invariant: creating a browser posts JSON to a relative URL, then opens it.
  it('New browser posts to a relative API URL with a JSON body, then opens it', async () => {
    goTo('');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ browser: running('fresh') }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [] });
    fireEvent.change(screen.getByLabelText('New browser name'), { target: { value: 'fresh' } });
    fireEvent.submit(screen.getByLabelText('New browser name').closest('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('api/browsers');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'fresh' });
    await waitFor(() => expect(location.search).toBe('?browser=fresh'));
  });

  // Invariant: Delete asks for confirmation first and does nothing when declined.
  it('Delete is confirmed first', async () => {
    goTo('');
    const fetchMock = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [running('a')] });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('api/browsers/a', expect.objectContaining({ method: 'DELETE' })));
  });
});

describe('view changes clear per-run state', () => {
  // Invariant: a dialog and state belong to one run of a browser; when it stops they are gone (the next start replays its own).
  it('stopping the browser clears its dialog and shows it as stopped', async () => {
    await openViewer({ kind: 'human', you: true });
    await f.emit({ type: 'dialog', tabId: 'T1', dialogType: 'alert', message: 'hi', defaultPrompt: '' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    await f.emit({ type: 'browsers', list: [{ ...running('a'), status: 'stopped' }] });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('status').getAttribute('data-status')).toBe('stopped');
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy();
  });
});

describe('reconnect', () => {
  class FakeWs {
    static all: FakeWs[] = [];
    readyState = 0; binaryType = '';
    onopen: (() => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null; onclose: (() => void) | null = null;
    constructor() { FakeWs.all.push(this); }
    send() {}
    close() {}
    open() { this.readyState = 1; this.onopen?.(); }
    drop() { this.readyState = 3; this.onclose?.(); }
    deliver(m: unknown) { act(() => { this.onmessage?.({ data: JSON.stringify(m) }); }); }
  }
  const dialogMsg = { type: 'dialog', tabId: 'T1', dialogType: 'alert', message: 'pending', defaultPrompt: '' };
  const boot = () => {
    vi.useFakeTimers();
    FakeWs.all = [];
    goTo('?browser=a');
    const socket = createViewerSocket({ url: 'ws://x/api/ws', viewerId: 'viewer-123456', createSocket: () => new FakeWs() as unknown as WebSocket });
    render(<App socket={socket} />);
    const first = FakeWs.all[0];
    act(() => first.open());
    first.deliver({ type: 'browsers', list: [running('a')] });
    first.deliver(state());
    first.deliver(dialogMsg);
    expect(screen.getByRole('dialog')).toBeTruthy();
    return { socket, first };
  };
  const reconnect = (first: FakeWs) => {
    act(() => first.drop());
    act(() => { vi.advanceTimersByTime(500); });
    const second = FakeWs.all[1];
    act(() => second.open());
    return second;
  };
  afterEach(() => { vi.useRealTimers(); });

  // Invariant: a dialog that was closed while the panel was disconnected does not survive the reconnect: the
  // modal goes when the socket drops and only dialogs the server still reports are shown again.
  it('a dialog closed while disconnected is gone after reconnect', () => {
    const { socket, first } = boot();
    act(() => first.drop());
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => { vi.advanceTimersByTime(500); });
    const second = FakeWs.all[1];
    act(() => second.open());
    second.deliver({ type: 'browsers', list: [running('a')] });
    second.deliver(state()); // the server replays state and open dialogs: none are open now
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('tablist')).toBeTruthy();
    socket.close();
  });

  // Invariant: a dialog that is still open on the server is shown again after reconnect (the replay repopulates it).
  it('a dialog still open on the server reappears after reconnect', () => {
    const { socket, first } = boot();
    const second = reconnect(first);
    second.deliver({ type: 'browsers', list: [running('a')] });
    second.deliver(state());
    second.deliver(dialogMsg);
    expect(screen.getByRole('dialog').textContent).toContain('pending');
    socket.close();
  });
});

describe('messages that beat the first render', () => {
  class FakeWs {
    readyState = 0; binaryType = ''; sent: string[] = [];
    onopen: (() => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null; onclose: (() => void) | null = null;
    send(d: string) { this.sent.push(d); }
    close() {}
    open() { this.readyState = 1; this.onopen?.(); }
    deliver(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
  }
  const realSocket = () => {
    let ws!: FakeWs;
    const socket = createViewerSocket({ url: 'ws://x/api/ws', viewerId: 'viewer-123456', createSocket: () => (ws = new FakeWs()) as unknown as WebSocket });
    return { socket, ws };
  };

  // Invariant: a `browsers` reply that arrives before App subscribes is not lost: the list renders without another message.
  it('the browser list renders from a reply delivered before mount', async () => {
    goTo('');
    const { socket, ws } = realSocket();
    ws.open();
    ws.deliver({ type: 'browsers', list: [running('a')] });
    render(<App socket={socket} />);
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
    socket.close();
  });

  // Invariant: a deep link does not sit at "Connecting…" when `browsers` and `state` both arrived before mount.
  it('a deep link shows the viewer from replies delivered before mount', async () => {
    goTo('?browser=a');
    const { socket, ws } = realSocket();
    ws.open();
    ws.deliver({ type: 'browsers', list: [running('a')] });
    ws.deliver(state());
    render(<App socket={socket} />);
    await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy());
    expect(screen.queryByText('Connecting…')).toBeNull();
    socket.close();
  });
});

describe('sandbox opt-in', () => {
  const stopped = (over: Partial<BrowserSummary> = {}): BrowserSummary => ({ ...running('a'), status: 'stopped', sandbox: null, ...over });
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const refusal = { error: 'SANDBOX_UNAVAILABLE: Chromium has no usable sandbox' };
  const post = (fetchMock: ReturnType<typeof vi.fn>, url: string) => (fetchMock.mock.calls as unknown as [string, RequestInit][]).filter(([u]) => u === url);

  async function openRefused(over: Partial<BrowserSummary> = {}) {
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [stopped({ sandboxUnavailable: true, ...over })] });
  }

  // Invariant: a refused start is explained where the human lands, with the way to allow it; nothing is sent yet.
  it('a refused browser shows the notice with Allow without sandbox…', async () => {
    const fetchMock = reply(200, {});
    vi.stubGlobal('fetch', fetchMock);
    await openRefused();
    const notice = screen.getByRole('region', { name: /no usable sandbox/i });
    expect(within(notice).getByRole('button', { name: /Allow without sandbox/ })).toBeTruthy();
    expect(within(notice).queryByRole('button', { name: 'Start' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Invariant: consent needs a second explicit step; Cancel sends nothing, Allow posts {allow:true} to the relative route.
  it('Allow needs a confirmation step; Cancel sends nothing, Allow posts JSON', async () => {
    const fetchMock = reply(200, { browser: stopped({ allowUnsandboxed: true }) });
    vi.stubGlobal('fetch', fetchMock);
    await openRefused();
    fireEvent.click(screen.getByRole('button', { name: /Allow without sandbox/ }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Allow without sandbox/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('api/browsers/a/allow-unsandboxed');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ allow: true });
  });

  // Invariant: once allowed, the notice offers Start, which starts the browser.
  it('with the opt-in on the notice offers Start', async () => {
    const fetchMock = reply(200, {});
    vi.stubGlobal('fetch', fetchMock);
    await openRefused({ allowUnsandboxed: true });
    const notice = screen.getByRole('region', { name: /no usable sandbox/i });
    expect(within(notice).queryByRole('button', { name: /Allow without sandbox/ })).toBeNull();
    fireEvent.click(within(notice).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(post(fetchMock, 'api/browsers/a/start')).toHaveLength(1));
  });

  // Invariant: a refusal is shown as the notice, never as an error toast, whichever message arrives first.
  it('a viewer Start refused with SANDBOX_UNAVAILABLE shows no toast', async () => {
    const fetchMock = reply(409, refusal);
    vi.stubGlobal('fetch', fetchMock);
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [stopped()] });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('alert')).toBeNull();
    await f.emit({ type: 'browsers', list: [stopped({ sandboxUnavailable: true })] });
    expect(screen.getByRole('region', { name: /no usable sandbox/i })).toBeTruthy();
  });

  it('other start failures still show a toast', async () => {
    vi.stubGlobal('fetch', reply(500, { error: 'LAUNCH_FAILED: boom' }));
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [stopped()] });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('LAUNCH_FAILED'));
  });

  // Invariant: a refused Start from the list or New browser takes the human to that browser's viewer, not a toast.
  it('a refused row Start and a refused New browser open the viewer', async () => {
    goTo('');
    vi.stubGlobal('fetch', reply(409, refusal));
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [stopped()] });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(location.search).toBe('?browser=a'));
    expect(screen.queryByRole('alert')).toBeNull();

    goTo('');
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
    fireEvent.change(screen.getByLabelText('New browser name'), { target: { value: 'fresh' } });
    fireEvent.submit(screen.getByLabelText('New browser name').closest('form')!);
    await waitFor(() => expect(location.search).toBe('?browser=fresh'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('browser list', () => {
    beforeEach(() => goTo(''));

    // Invariant: an allowed browser is marked in the list and can be disallowed; one not allowed has no Disallow.
    it('shows the allowed badge and Disallow only with the opt-in', async () => {
      render(<App socket={f.socket} />);
      await f.emit({ type: 'browsers', list: [stopped({ allowUnsandboxed: true }), stopped({ name: 'b' })] });
      expect(screen.getAllByRole('button', { name: 'Disallow without sandbox' })).toHaveLength(1);
      expect(screen.getByText('allowed without sandbox')).toBeTruthy();
    });

    it('marks a refused, not-allowed browser', async () => {
      render(<App socket={f.socket} />);
      await f.emit({ type: 'browsers', list: [stopped({ sandboxUnavailable: true })] });
      expect(screen.getByText('not started: no sandbox')).toBeTruthy();
    });

    // Invariant: disallowing a browser that runs unsandboxed asks first (it stops now); declining sends nothing.
    it('Disallow on a running unsandboxed browser confirms first', async () => {
      const fetchMock = reply(200, {});
      vi.stubGlobal('fetch', fetchMock);
      const confirm = vi.fn(() => false);
      vi.stubGlobal('confirm', confirm);
      render(<App socket={f.socket} />);
      await f.emit({ type: 'browsers', list: [running('a', 'agent'), ].map((b) => ({ ...b, sandbox: false, allowUnsandboxed: true })) });
      fireEvent.click(screen.getByRole('button', { name: 'Disallow without sandbox' }));
      expect(confirm).toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByRole('button', { name: 'Disallow without sandbox' }));
      await waitFor(() => expect(post(fetchMock, 'api/browsers/a/allow-unsandboxed')).toHaveLength(1));
      expect(JSON.parse(post(fetchMock, 'api/browsers/a/allow-unsandboxed')[0][1].body as string)).toEqual({ allow: false });
    });

    // Invariant: disallowing where nothing is running unsandboxed changes no process, so it needs no confirmation.
    it('Disallow on a stopped browser posts {allow:false} without a confirm', async () => {
      const fetchMock = reply(200, {});
      vi.stubGlobal('fetch', fetchMock);
      const confirm = vi.fn(() => true);
      vi.stubGlobal('confirm', confirm);
      render(<App socket={f.socket} />);
      await f.emit({ type: 'browsers', list: [stopped({ allowUnsandboxed: true })] });
      fireEvent.click(screen.getByRole('button', { name: 'Disallow without sandbox' }));
      await waitFor(() => expect(post(fetchMock, 'api/browsers/a/allow-unsandboxed')).toHaveLength(1));
      expect(confirm).not.toHaveBeenCalled();
      expect(JSON.parse(post(fetchMock, 'api/browsers/a/allow-unsandboxed')[0][1].body as string)).toEqual({ allow: false });
    });
  });
});
