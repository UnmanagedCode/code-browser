import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { BrowserState, BrowserSummary, ClientMessage, FrameHeader, ServerMessage, Tab } from './protocol';
import { TOAST_MS } from './components/Toast';
import { INSTALL_POLL_MS } from '../../src/limits.js';
import { createViewerSocket, type SocketStatus, type ViewerSocket, type View } from './socket';

function fakeSocket() {
  const msgFns = new Set<(m: ServerMessage) => void>();
  const frameFns = new Set<(h: FrameHeader, j: Uint8Array) => void>();
  const sent: ClientMessage[] = [];
  const views: (View | null)[] = [];
  const statusFns = new Set<(s: SocketStatus, n: number) => void>();
  const retry = vi.fn();
  const socket: ViewerSocket = {
    send: (m) => { sent.push(m); return true; },
    setView: (v) => { views.push(v); },
    setViewport: () => {},
    onMessage: (fn) => { msgFns.add(fn); return () => { msgFns.delete(fn); }; },
    onFrame: (fn) => { frameFns.add(fn); return () => { frameFns.delete(fn); }; },
    onStatus: (fn) => { statusFns.add(fn); return () => { statusFns.delete(fn); }; },
    retry,
    close: () => {},
  };
  return {
    socket, sent, views, retry,
    status: (s: SocketStatus, n = 0) => act(() => { statusFns.forEach((fn) => fn(s, n)); }),
    emit: (m: ServerMessage) => act(() => { msgFns.forEach((fn) => fn(m)); }),
    frame: (h: FrameHeader) => act(async () => { frameFns.forEach((fn) => fn(h, new Uint8Array([1]))); await Promise.resolve(); await Promise.resolve(); }),
    inputs: () => sent.filter((m) => m.msg === 'input'),
  };
}

const running = (name: string, controller: BrowserSummary['controller'] = 'agent'): BrowserSummary => ({ name, kind: 'launched', status: 'running', controller, sandbox: true, allowUnsandboxed: false, sandboxUnavailable: false, lastExit: null, attached: null, attachError: null });
const state = (over: Partial<BrowserState> = {}): BrowserState => ({
  type: 'state', name: 'a', status: 'running', sandbox: true, controller: { kind: 'agent' },
  tabs: [{ targetId: 'T1', url: 'https://one.test/', title: 'One', windowId: 1 }], activeTabId: 'T1', canGoBack: false, canGoForward: false, ...over,
});
const mkTab = (targetId: string, title: string, url = `https://${targetId.toLowerCase()}.test/`, windowId: number | null = 1): Tab => ({ targetId, url, title, windowId });
const goTo = (search: string) => history.replaceState(null, '', search || location.pathname);
// The panel asks the backend about a Chromium install whenever the socket opens; tests that open it answer idle.
const stubIdleInstall = () => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ install: { status: 'idle', error: null, exitCode: null, logTail: '' } }) })));

const openMenu = (name: string) => { fireEvent.click(screen.getByRole('button', { name: `More actions for ${name}` })); return screen.getByRole('menu'); };
const pick = (name: string, item: string) => { fireEvent.click(within(openMenu(name)).getByRole('menuitem', { name: item })); };
const group = (name: string) => screen.getByRole('group', { name });
// The `role=status` region of a stopped/connecting view (the page also holds always-mounted live regions).
const statusOf = () => screen.getAllByRole('status').find((el) => el.hasAttribute('data-status'))!;

let f: ReturnType<typeof fakeSocket>;
// happy-dom has no pointer media features: viewer tests default to a mouse-only device.
function stubPointer(coarse: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: coarse && query.includes('any-pointer: coarse'), media: query, addEventListener() {}, removeEventListener() {} }));
}
beforeEach(() => {
  f = fakeSocket();
  stubPointer(false);
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
    expect(screen.getAllByRole('button', { name: 'Open a' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Start b' })).toBeTruthy();
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
    await f.emit(state({ tabs: [{ targetId: 'T1', url: 'https://one.test/', title, windowId: 1 }] }));
    expect(document.querySelector('.tab-label')?.textContent).toBe(title);
    expect(document.querySelector('img')).toBeNull();
  });

  // Invariant: a hostile title shown in a switcher option stays text.
  it('a hostile tab title in the switcher becomes text, not an element', async () => {
    const title = '<img src=x onerror="window.__pwned=1">';
    await openViewer();
    await f.emit(state({ tabs: [mkTab('T1', title)] }));
    fireEvent.click(screen.getByRole('button', { name: /Search \d+ tabs/ }));
    expect(document.querySelector('.tab-option-label')?.textContent).toBe(title);
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

  // Invariant: the control button is one element across states, so keyboard focus stays on it when control changes hands.
  it('focus stays on the control button when control is taken and handed back', async () => {
    await openViewer({ kind: 'agent' });
    const take = screen.getByRole('button', { name: 'Take control' });
    take.focus();
    fireEvent.click(take);
    await f.emit(state({ controller: { kind: 'human', you: true } }));
    const handBack = screen.getByRole('button', { name: 'Hand back' });
    expect(document.activeElement).toBe(handBack);
    fireEvent.click(handBack);
    await f.emit(state({ controller: { kind: 'agent' } }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Take control' }));
  });

  // Invariant: actions that need control are disabled without it, and enabled with it.
  it('tab close/new and navigation need control', async () => {
    await openViewer({ kind: 'agent' });
    for (const name of ['New tab', 'Close tab One', 'Reload']) {
      expect((screen.getByLabelText(name) as HTMLButtonElement).disabled, name).toBe(true);
    }
    expect((screen.getByRole('textbox', { name: 'Address' }) as HTMLInputElement).readOnly).toBe(true);
    await f.emit(state({ controller: { kind: 'human', you: true } }));
    for (const name of ['New tab', 'Close tab One', 'Reload']) {
      expect((screen.getByLabelText(name) as HTMLButtonElement).disabled, name).toBe(false);
    }
  });

  // Invariant: icon-only toolbar buttons keep an accessible name (the icon is decorative).
  it('icon-only toolbar buttons are named', async () => {
    await openViewer({ kind: 'human', you: true });
    for (const name of ['Back to browsers', 'Go back', 'Go forward', 'Reload']) {
      expect(screen.getByRole('button', { name }), name).toBeTruthy();
    }
  });

  // Invariant: the Keyboard button exists only where a touch pointer does; a mouse device types by clicking the screen.
  it('the Keyboard button is hidden without a touch pointer', async () => {
    await openViewer({ kind: 'human', you: true });
    expect(screen.queryByRole('button', { name: 'Keyboard' })).toBeNull();
  });

  // Invariant: on touch the button toggles focus on the keyboard sink and mirrors it in aria-pressed; it needs control.
  it('the Keyboard button toggles focus and aria-pressed on a touch device', async () => {
    stubPointer(true);
    await openViewer({ kind: 'agent' });
    expect((screen.getByRole('button', { name: 'Keyboard' }) as HTMLButtonElement).disabled).toBe(true);
    await f.emit(state({ controller: { kind: 'human', you: true } }));
    const button = screen.getByRole('button', { name: 'Keyboard' });
    const sink = screen.getByRole('textbox', { name: 'Keyboard input' });
    fireEvent.click(button);
    expect(document.activeElement).toBe(sink);
    await waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(button);
    expect(document.activeElement).not.toBe(sink);
    await waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('false'));
  });

  // Invariant: pressing the Keyboard button must not take focus from the sink before click (touch fires a compatibility
  // mousedown), or the click would see an unfocused sink and reopen the keyboard instead of closing it.
  it('the Keyboard button cancels mousedown so a press toggles the keyboard closed', async () => {
    stubPointer(true);
    await openViewer({ kind: 'human', you: true });
    const button = screen.getByRole('button', { name: 'Keyboard' });
    const sink = screen.getByRole('textbox', { name: 'Keyboard input' });
    fireEvent.click(button);
    expect(document.activeElement).toBe(sink);
    expect(fireEvent.mouseDown(button)).toBe(false); // false: the default (focus change) was prevented
    expect(document.activeElement).toBe(sink);
    fireEvent.click(button);
    expect(document.activeElement).not.toBe(sink);
    await waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('false'));
  });

  // Invariant: with no screen mounted (tabs exist but none is selected) there is no sink to focus, so no button.
  it('no Keyboard button while there is no screen', async () => {
    stubPointer(true);
    await openViewer({ kind: 'human', you: true });
    await f.emit(state({ controller: { kind: 'human', you: true }, activeTabId: null }));
    expect(screen.getByText('Select a tab to watch it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keyboard' })).toBeNull();
  });

  // Invariant: the viewer stops a launched browser, or disconnects an attached one, through the same stop route as the list.
  it('Stop and Disconnect in the viewer post the stop route', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    await openViewer({ kind: 'human', you: true });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('api/browsers/a/stop', expect.objectContaining({ method: 'POST' })));
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  it('an attached browser offers Disconnect, not Stop', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [{ ...running('a'), kind: 'attached', sandbox: null, attached: { address: '127.0.0.1:9222', via: 'proxy', asksApproval: null } }] });
    await f.emit(state());
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('api/browsers/a/stop', expect.objectContaining({ method: 'POST' })));
  });

  // Invariant: switching the viewed tab needs no control.
  it('selecting a tab sends activate without control', async () => {
    await openViewer({ kind: 'agent' });
    await f.emit(state({ tabs: [{ targetId: 'T1', url: 'a', title: 'One', windowId: 1 }, { targetId: 'T2', url: 'b', title: 'Two', windowId: 1 }] }));
    fireEvent.click(screen.getByRole('tab', { name: 'Two' }));
    expect(f.sent).toContainEqual({ msg: 'tab', action: 'activate', tabId: 'T2' });
    expect(screen.getByRole('tab', { name: /^One/ }).getAttribute('aria-selected')).toBe('true');
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
  const canvas = () => screen.getByRole('img', { name: 'Live view of the page' });

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
    // The hint is a button that takes control.
    fireEvent.click(screen.getByRole('button', { name: 'Take control to interact' }));
    expect(f.sent).toContainEqual({ msg: 'control', action: 'take' });

    await f.emit(state({ controller: { kind: 'human', you: true } }));
    expect(screen.queryByRole('button', { name: 'Take control to interact' })).toBeNull();
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

  // Invariant: a dialog from a background tab names that tab and can bring it forward without control; no button
  // is offered when its tab is already the watched one.
  it('a dialog from a background tab names its tab and Show tab activates it without control', async () => {
    await openViewer({ kind: 'agent' });
    await f.emit(state({ tabs: [mkTab('T1', 'One'), mkTab('T2', 'Two')] }));
    await f.emit({ type: 'dialog', tabId: 'T2', dialogType: 'alert', message: 'hi', defaultPrompt: '' });
    const dialog = screen.getByRole('dialog', { name: 'Page dialog' });
    expect(within(dialog).getByText('Two').closest('p')?.textContent).toMatch(/^From tab: Two — t2\.test/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show tab' }));
    expect(f.sent).toContainEqual({ msg: 'tab', action: 'activate', tabId: 'T2' });
    await f.emit(state({ tabs: [mkTab('T1', 'One'), mkTab('T2', 'Two')], activeTabId: 'T2' }));
    expect(screen.queryByRole('button', { name: 'Show tab' })).toBeNull();
  });
});

describe('errors and the list', () => {
  // Invariant: a server error is shown to the user, not swallowed.
  it('shows server errors in an alert, in plain words with the code as detail', async () => {
    await openViewer();
    await f.emit({ type: 'error', code: 'NOT_CONTROLLER', message: 'take control first' });
    expect(screen.getByRole('alert').textContent).toContain('Take control first.');
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

  // Invariant: Delete asks for confirmation in place first; Cancel sends nothing and returns focus to the row's menu button.
  it('Delete is confirmed inline first', async () => {
    goTo('');
    const fetchMock = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    const nativeConfirm = vi.fn(() => { throw new Error('native confirm used'); });
    vi.stubGlobal('confirm', nativeConfirm);
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [running('a')] });
    pick('a', 'Delete');
    expect(group('Confirm delete').textContent).toContain('Delete browser "a" and its logins?');
    expect(document.activeElement).toBe(within(group('Confirm delete')).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(group('Confirm delete')).getByRole('button', { name: 'Cancel' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Confirm delete' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More actions for a' }));
    pick('a', 'Delete');
    fireEvent.click(within(group('Confirm delete')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('api/browsers/a', expect.objectContaining({ method: 'DELETE' })));
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  // Invariant: Escape inside an inline confirmation cancels it.
  it('Escape cancels an inline confirmation', async () => {
    goTo('');
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [running('a')] });
    pick('a', 'Delete');
    fireEvent.keyDown(within(group('Confirm delete')).getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Confirm delete' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(statusOf().getAttribute('data-status')).toBe('stopped');
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy();
  });
});

describe('reconnect', () => {
  beforeEach(stubIdleInstall);
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
  beforeEach(stubIdleInstall);
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
    expect(screen.getByRole('button', { name: 'Open a' })).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Start a' }));
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

    // Invariant: an allowed browser is marked in the list and can be disallowed; one not allowed has no Disallow item.
    it('shows the allowed marker and Disallow only with the opt-in', async () => {
      render(<App socket={f.socket} />);
      await f.emit({ type: 'browsers', list: [stopped({ allowUnsandboxed: true }), stopped({ name: 'b' })] });
      expect(screen.getByText('allowed without sandbox')).toBeTruthy();
      expect(within(openMenu('a')).getByRole('menuitem', { name: 'Disallow without sandbox' })).toBeTruthy();
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      expect(within(openMenu('b')).queryByRole('menuitem', { name: 'Disallow without sandbox' })).toBeNull();
    });

    it('marks a refused, not-allowed browser', async () => {
      render(<App socket={f.socket} />);
      await f.emit({ type: 'browsers', list: [stopped({ sandboxUnavailable: true })] });
      expect(screen.getByText('not started: no sandbox')).toBeTruthy();
    });

    // Invariant: disallowing a browser that runs unsandboxed asks first (it stops now); cancelling sends nothing.
    it('Disallow on a running unsandboxed browser confirms inline first', async () => {
      const fetchMock = reply(200, {});
      vi.stubGlobal('fetch', fetchMock);
      render(<App socket={f.socket} />);
      await f.emit({ type: 'browsers', list: [{ ...running('a', 'agent'), sandbox: false, allowUnsandboxed: true }] });
      pick('a', 'Disallow without sandbox');
      expect(group('Confirm stop and disallow').textContent).toContain('withdrawing the permission stops it');
      fireEvent.click(within(group('Confirm stop and disallow')).getByRole('button', { name: 'Cancel' }));
      expect(fetchMock).not.toHaveBeenCalled();
      pick('a', 'Disallow without sandbox');
      fireEvent.click(within(group('Confirm stop and disallow')).getByRole('button', { name: 'Stop and disallow' }));
      await waitFor(() => expect(post(fetchMock, 'api/browsers/a/allow-unsandboxed')).toHaveLength(1));
      expect(JSON.parse(post(fetchMock, 'api/browsers/a/allow-unsandboxed')[0][1].body as string)).toEqual({ allow: false });
    });

    // Invariant: disallowing where nothing runs unsandboxed changes no process, so it needs no confirmation.
    it('Disallow on a stopped browser posts {allow:false} without a confirmation', async () => {
      const fetchMock = reply(200, {});
      vi.stubGlobal('fetch', fetchMock);
      render(<App socket={f.socket} />);
      await f.emit({ type: 'browsers', list: [stopped({ allowUnsandboxed: true })] });
      pick('a', 'Disallow without sandbox');
      await waitFor(() => expect(post(fetchMock, 'api/browsers/a/allow-unsandboxed')).toHaveLength(1));
      expect(screen.queryByRole('group')).toBeNull();
      expect(JSON.parse(post(fetchMock, 'api/browsers/a/allow-unsandboxed')[0][1].body as string)).toEqual({ allow: false });
    });
  });
});

describe('attached browsers', () => {
  const attached = (over: Partial<BrowserSummary> = {}, a: Partial<NonNullable<BrowserSummary['attached']>> = {}): BrowserSummary => ({
    ...running('mine'), kind: 'attached', status: 'stopped', sandbox: null, attached: { address: '127.0.0.1:9222', via: 'proxy', asksApproval: null, ...a }, ...over,
  });
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const calls = (fetchMock: ReturnType<typeof vi.fn>, url: string) => (fetchMock.mock.calls as unknown as [string, RequestInit][]).filter(([u]) => u === url);
  const list = async (b: BrowserSummary[]) => { goTo(''); render(<App socket={f.socket} />); await f.emit({ type: 'browsers', list: b }); };

  // Invariant: the attach form defaults to 127.0.0.1:9222 through the proxy, and posts the name, the debug address and
  // how to reach it.
  it('the attach form posts {address, via}', async () => {
    const fetchMock = reply(202, { browser: attached({ status: 'connecting' }) });
    vi.stubGlobal('fetch', fetchMock);
    await list([]);
    expect(screen.queryByRole('form', { name: 'Attach a browser' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Attach a browser…' }));
    const form = screen.getByRole('form', { name: 'Attach a browser' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Name' }), { target: { value: 'mine' } });
    expect((within(form).getByRole('textbox', { name: 'Debug address' }) as HTMLInputElement).value).toBe('127.0.0.1:9222');
    expect((within(form).getByRole('radio', { name: /On the Docker host/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(form).getByRole('radio', { name: /On this machine/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(form).getByRole('radio', { name: /On this machine/ }));
    fireEvent.submit(form);
    await waitFor(() => expect(calls(fetchMock, 'api/browsers/mine/attach')).toHaveLength(1));
    const [, init] = calls(fetchMock, 'api/browsers/mine/attach')[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ address: '127.0.0.1:9222', via: 'direct' });
  });

  // Invariant: an attached row shows what it is and how it is reached, offers Connect when stopped (posting connect),
  // and has no sandbox or Start controls.
  it('a stopped attached row offers Connect, Change… and Forget, and no sandbox controls', async () => {
    const fetchMock = reply(202, { browser: attached({ status: 'connecting' }) });
    vi.stubGlobal('fetch', fetchMock);
    await list([attached({ lastExit: { code: null, signal: null, at: 1 } }, { asksApproval: true })]);
    for (const text of ['attached', 'via proxy', 'asks approval', 'Disconnected', '127.0.0.1:9222']) expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Start/ })).toBeNull();
    expect(within(openMenu('mine')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Open', 'Change…', 'Forget']);
    expect(screen.queryByText('Crashed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Connect mine' }));
    await waitFor(() => expect(calls(fetchMock, 'api/browsers/mine/connect')).toHaveLength(1));
  });

  // Invariant: Forget asks inline first and says the browser is untouched; Disconnect posts stop; Change… opens the form
  // prefilled, scrolls it into view and focuses Name; Cancel collapses it.
  it('Forget confirms, Disconnect stops, Change… prefills the form', async () => {
    const fetchMock = reply(200, { ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    await list([attached({ status: 'running' }, { via: 'direct', address: '127.0.0.1:9333' })]);
    pick('mine', 'Forget');
    expect(group('Confirm forget').textContent).toMatch(/untouched/);
    fireEvent.click(within(group('Confirm forget')).getByRole('button', { name: 'Cancel' }));
    expect(fetchMock).not.toHaveBeenCalled();
    pick('mine', 'Disconnect');
    await waitFor(() => expect(calls(fetchMock, 'api/browsers/mine/stop')).toHaveLength(1));
    pick('mine', 'Change…');
    const form = screen.getByRole('form', { name: 'Attach a browser' });
    expect((within(form).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('mine');
    expect((within(form).getByRole('textbox', { name: 'Debug address' }) as HTMLInputElement).value).toBe('127.0.0.1:9333');
    expect((within(form).getByRole('radio', { name: /On this machine/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(form).getByText(/Changing "mine"/)).toBeTruthy();
    expect(scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(within(form).getByRole('textbox', { name: 'Name' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Attach a browser' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Attach a browser…' }));
  });

  // Invariant: a failed connect's message and the Allow hint while connecting are shown as text, never markup.
  it('attachError and the Allow hint render as text', async () => {
    const hostile = '<img src=x onerror="window.__pwned=1"> start the proxy with --ports 9222,9333';
    await list([attached({ attachError: hostile }), attached({ name: 'two', status: 'connecting' })]);
    expect(screen.getByText(hostile).textContent).toBe(hostile);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(/click Allow/)).toBeTruthy();
  });

  // Invariant: the viewer of a disconnected attached browser says so, shows the last error and offers Connect; while
  // connecting it shows the Allow hint; nothing is joined.
  it('the viewer shows disconnected with Connect, and the Allow hint while connecting', async () => {
    const fetchMock = reply(202, {});
    vi.stubGlobal('fetch', fetchMock);
    goTo('?browser=mine');
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [attached({ attachError: 'nobody allowed it' })] });
    expect(screen.getByText('This browser is disconnected.')).toBeTruthy();
    expect(screen.getByText('nobody allowed it')).toBeTruthy();
    expect(f.views.at(-1)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(calls(fetchMock, 'api/browsers/mine/connect')).toHaveLength(1));
    await f.emit({ type: 'browsers', list: [attached({ status: 'connecting' })] });
    expect(screen.getByText(/click Allow/)).toBeTruthy();
    expect(f.views.at(-1)).toBeNull();
  });

  // Invariant: with tabs but no active one (a user's browser nobody has picked a tab in), the viewer asks to pick one.
  it('tabs without an active tab ask to select one', async () => {
    goTo('?browser=mine');
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [attached({ status: 'running' })] });
    await f.emit(state({ name: 'mine', sandbox: null, activeTabId: null }));
    expect(screen.getByText('Select a tab to watch it.')).toBeTruthy();
    expect(document.querySelector('canvas')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'One' }));
    expect(f.sent).toContainEqual({ msg: 'tab', action: 'activate', tabId: 'T1' });
  });
});

describe('tab switcher', () => {
  const three = [mkTab('T1', 'Alpha', 'https://alpha.test/x'), mkTab('T2', 'Beta', 'https://beta.test/y'), mkTab('T3', 'Gamma', 'https://gamma.test/z')];
  const trigger = () => screen.getByRole('button', { name: /Search \d+ tabs/ });
  const search = () => screen.getByRole('combobox', { name: 'Search tabs' });
  const labels = () => within(screen.getByRole('listbox', { name: 'Tabs' })).queryAllByRole('option').map((o) => o.querySelector('.tab-option-label')?.textContent);
  const open = async (tabs: Tab[] = three, over: Partial<BrowserState> = {}) => {
    await openViewer();
    await f.emit(state({ tabs, ...over }));
    fireEvent.click(trigger());
  };

  // Invariant: the trigger opens a focused search that filters by title and by host.
  it('opens focused and filters by title and host', async () => {
    await open();
    expect(document.activeElement).toBe(search());
    expect(labels()).toEqual(['Alpha', 'Beta', 'Gamma']);
    fireEvent.change(search(), { target: { value: 'bet' } });
    expect(labels()).toEqual(['Beta']);
    fireEvent.change(search(), { target: { value: 'gamma.test' } });
    expect(labels()).toEqual(['Gamma']);
    fireEvent.change(search(), { target: { value: 'zzz' } });
    expect(screen.getByText('No tabs match')).toBeTruthy();
  });

  // Invariant: keyboard choice activates the highlighted tab (no control needed), closes, and returns focus to the trigger.
  it('ArrowDown then Enter picks the highlighted tab and restores focus', async () => {
    await open();
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    expect(search().getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1].id);
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(f.sent).toContainEqual({ msg: 'tab', action: 'activate', tabId: 'T2' });
    expect(screen.queryByRole('dialog', { name: 'Search tabs' })).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  // Invariant: Escape and an outside press dismiss the switcher without choosing anything.
  it('Escape and an outside press close it and send nothing', async () => {
    await open();
    fireEvent.keyDown(search(), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Search tabs' })).toBeNull();
    expect(document.activeElement).toBe(trigger());
    fireEvent.click(trigger());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'Search tabs' })).toBeNull();
    expect(f.sent.filter((m) => m.msg === 'tab')).toEqual([]);
  });

  // Invariant: a mouse click on an option picks that tab.
  it('clicking an option picks it', async () => {
    await open();
    fireEvent.click(screen.getByRole('option', { name: /Gamma/ }));
    expect(f.sent).toContainEqual({ msg: 'tab', action: 'activate', tabId: 'T3' });
  });

  // Invariant: windows are grouped only when there is more than one.
  it('groups options by window only with several windows', async () => {
    await open([mkTab('T1', 'Alpha', undefined, 7), mkTab('T2', 'Beta', undefined, 9), mkTab('T3', 'Gamma', undefined, 7)]);
    expect(screen.getByRole('group', { name: /Window 1 · 2 tabs/ })).toBeTruthy();
    expect(within(screen.getByRole('group', { name: /Window 2/ })).getByRole('option', { name: /Beta/ })).toBeTruthy();
    expect(labels()).toEqual(['Alpha', 'Gamma', 'Beta']);
  });
  it('shows a flat list for one window', async () => {
    await open();
    expect(screen.queryAllByRole('group')).toEqual([]);
  });

  // Invariant: Recent orders by the backend's recency, then the rest in list order.
  it('Recent orders by recentTabIds', async () => {
    await open(three, { recentTabIds: ['T3', 'T2'] });
    fireEvent.click(screen.getByRole('radio', { name: 'Recent' }));
    expect(labels()).toEqual(['Gamma', 'Beta', 'Alpha']);
  });

  // Invariant: browser pages are hidden until asked for, except the watched tab, which is always listed.
  it('hides browser pages by default; the active one is always shown', async () => {
    const tabs = [mkTab('T1', 'Alpha'), mkTab('T2', 'About Version', 'chrome://version/')];
    await open(tabs);
    expect(labels()).toEqual(['Alpha']);
    expect(screen.queryByRole('tab', { name: /About Version/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Show browser pages \(1\)/ }));
    expect(labels()).toEqual(['Alpha', 'About Version']);
    expect(screen.getByRole('tab', { name: /About Version/ })).toBeTruthy();
  });
  it('lists an internal tab when it is the active one', async () => {
    await open([mkTab('T1', 'About Version', 'chrome://version/')]);
    expect(labels()).toEqual(['About Version']);
    expect(screen.getByRole('tab', { name: /About Version/ })).toBeTruthy();
  });

  // Invariant: the strip's arrows move focus without changing the shared tab; Enter activates.
  it('strip arrows move focus only; Enter activates', async () => {
    await openViewer();
    await f.emit(state({ tabs: three }));
    const [a, b] = [screen.getByRole('tab', { name: /Alpha/ }), screen.getByRole('tab', { name: /Beta/ })];
    a.focus();
    fireEvent.keyDown(a, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(b);
    expect(f.sent.filter((m) => m.msg === 'tab')).toEqual([]);
    fireEvent.keyDown(b, { key: 'Enter' });
    expect(f.sent).toContainEqual({ msg: 'tab', action: 'activate', tabId: 'T2' });
  });

  // Invariant: a newly active tab is scrolled into view in the strip.
  it('scrolls the newly active tab into view', async () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    await openViewer();
    await f.emit(state({ tabs: three }));
    spy.mockClear();
    await f.emit(state({ tabs: three, activeTabId: 'T3' }));
    expect((spy.mock.contexts as HTMLElement[]).some((el) => el.getAttribute('role') === 'tab' && el.textContent?.includes('Gamma'))).toBe(true);
  });

  // Invariant: the strip says which tab is shared with the agent and which tabs hold a dialog.
  it('badges the shared tab and tabs with a dialog', async () => {
    await openViewer();
    await f.emit(state({ tabs: three }));
    await f.emit({ type: 'dialog', tabId: 'T2', dialogType: 'alert', message: 'hi', defaultPrompt: '' });
    expect(screen.getByRole('tab', { name: /Alpha.*\(shared with agent\)/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Beta.*\(has open dialog\)/ })).toBeTruthy();
  });

  // Invariant: a page titled like a badge does not get the badge's accessible name.
  it('a title that says "Shared" is not mistaken for the badge', async () => {
    await openViewer();
    await f.emit(state({ tabs: [mkTab('T1', 'Alpha'), mkTab('T2', 'Shared')] }));
    expect(screen.getByRole('tab', { name: 'Shared' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Alpha.*\(shared with agent\)/ })).toBeTruthy();
  });

  // Invariant: sort and browser-pages controls keep the keyboard working; Escape closes from any control inside.
  it('arrows and Escape work after clicking Recent', async () => {
    await open(three);
    const recent = screen.getByRole('radio', { name: 'Recent' });
    fireEvent.click(recent);
    const before = search().getAttribute('aria-activedescendant');
    expect(fireEvent.keyDown(recent, { key: 'ArrowDown' }), 'the radio keeps its arrow keys').toBe(true);
    expect(search().getAttribute('aria-activedescendant')).toBe(before);
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    expect(search().getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1].id);
    fireEvent.keyDown(recent, { key: 'Enter' });
    expect(f.sent.filter((m) => m.msg === 'tab')).toEqual([]);
    fireEvent.keyDown(recent, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Search tabs' })).toBeNull();
  });

  // Invariant: the unknown-window group is named "Other tabs", never a numbered window; headings count matches clearly.
  it('names the unknown-window group and counts filtered tabs', async () => {
    await open([mkTab('T1', 'Alpha', undefined, 7), mkTab('T2', 'Beta', undefined, 9), mkTab('T3', 'Gamma', undefined, null), mkTab('T4', 'Beta two', undefined, 9)]);
    expect(screen.getByRole('group', { name: 'Other tabs · 1 tab' })).toBeTruthy();
    fireEvent.change(search(), { target: { value: 'two' } });
    expect(screen.getByRole('group', { name: 'Window 2 · 1 of 2 tabs' })).toBeTruthy();
  });

  // Invariant: with several windows, Recent badges number real windows only.
  it('Recent shows no Window badge for unknown-window tabs', async () => {
    await open([mkTab('T1', 'Alpha', undefined, 7), mkTab('T2', 'Beta', undefined, null)]);
    fireEvent.click(screen.getByRole('radio', { name: 'Recent' }));
    const [first, second] = screen.getAllByRole('option');
    expect(first.textContent).toContain('Window 1');
    expect(second.textContent).not.toMatch(/Window/);
  });

  // Invariant: an attached browser with no tab picked offers the switcher from its empty state.
  it('Find a tab… opens the switcher', async () => {
    await openViewer();
    await f.emit(state({ tabs: three, activeTabId: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Find a tab…' }));
    expect(screen.getByRole('dialog', { name: 'Search tabs' })).toBeTruthy();
    expect(document.activeElement).toBe(search());
  });

  // Invariant: a title with bidi controls cannot reorder the trusted text beside it: controls are stripped, and every
  // page-derived label is isolated in its own element with the host span last.
  it('bidi controls in a title do not reach or reorder the host', async () => {
    const title = 'evil\u202E gnp.exe';
    await openViewer();
    await f.emit(state({ tabs: [mkTab('T1', 'Alpha'), mkTab('T2', title, 'https://t2.test/')] }));
    await f.emit({ type: 'dialog', tabId: 'T2', dialogType: 'alert', message: 'hi', defaultPrompt: '' });
    const source = document.querySelector('.dialog-source') as HTMLElement;
    expect(source.textContent).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    expect(source.querySelector('strong > bdi')?.textContent).toBe('evil gnp.exe');
    expect(source.querySelector('.dialog-host')?.compareDocumentPosition(source.querySelector('strong')!)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    fireEvent.click(screen.getByRole('button', { name: /Search \d+ tabs/ }));
    expect(document.querySelectorAll('.tab-option-label bdi, .tab-label bdi').length).toBe(4);
    const tip = screen.getByRole('tab', { name: /evil/ }).getAttribute('data-tip') ?? '';
    expect(tip).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
  });
});

describe('connection loss', () => {
  beforeEach(stubIdleInstall);
  // Invariant: the banner appears only after a failed attempt, names the attempt, and Retry now calls socket.retry.
  it('shows the banner with the attempt and Retry now only after a drop', async () => {
    await openViewer();
    await f.status('connecting', 0);
    expect(screen.queryByText(/connection/i)).toBeNull();
    await f.status('closed', 2);
    expect(screen.getByText(/attempt 2/).textContent).toContain('attempt 2');
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(f.retry).toHaveBeenCalled();
    await f.status('connecting', 2);
    expect(screen.getByText(/Reconnecting to code-browser \(attempt 2\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry now' })).toBeNull();
    await f.status('open', 0);
    expect(screen.queryByText(/attempt/)).toBeNull();
  });

  // Invariant: when the socket drops, the browser list is cleared (it is stale) and says it is waiting.
  it('clears the list on a drop and shows a waiting note', async () => {
    goTo('');
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [running('a')] });
    expect(screen.getByText('a')).toBeTruthy();
    await f.status('closed', 1);
    expect(screen.queryByText('a')).toBeNull();
    expect(screen.getByText('Waiting for code-browser…')).toBeTruthy();
    await f.emit({ type: 'browsers', list: [running('a')] });
    expect(screen.queryByText('Waiting for code-browser…')).toBeNull();
  });

  // Invariant: offline, the viewer keeps its last frame and tabs but is inert, dimmed and cannot be driven.
  it('the viewer stays mounted, dimmed and inert while offline', async () => {
    await openViewer({ kind: 'human', you: true });
    expect(screen.getByRole('button', { name: 'Reload' }).hasAttribute('disabled')).toBe(false);
    await f.status('closed', 1);
    const body = document.querySelector('.viewer-body')!;
    expect(body.hasAttribute('inert')).toBe(true);
    expect(body.hasAttribute('data-offline')).toBe(true);
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(document.querySelector('canvas')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Back to browsers' }).hasAttribute('disabled')).toBe(false);
  });

  // Invariant: no view is joined while offline; the view returns only once a fresh list says the browser runs.
  it('rejoins only after a fresh list', async () => {
    await openViewer();
    expect(f.views.at(-1)).toMatchObject({ name: 'a' });
    await f.status('closed', 1);
    expect(f.views.at(-1)).toBeNull();
    await f.status('open', 0);
    expect(f.views.at(-1)).toBeNull();
    await f.emit({ type: 'browsers', list: [running('a')] });
    expect(f.views.at(-1)).toMatchObject({ name: 'a' });
  });
});

describe('connection loss with the real socket', () => {
  beforeEach(stubIdleInstall);
  class FakeWs {
    static all: FakeWs[] = [];
    readyState = 0; binaryType = ''; sent: { msg: string }[] = [];
    onopen: (() => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null; onclose: (() => void) | null = null;
    constructor() { FakeWs.all.push(this); }
    send(d: string) { this.sent.push(JSON.parse(d)); }
    close() {}
    open() { this.readyState = 1; this.onopen?.(); }
    drop() { this.readyState = 3; this.onclose?.(); }
    deliver(m: unknown) { act(() => { this.onmessage?.({ data: JSON.stringify(m) }); }); }
  }
  afterEach(() => { vi.useRealTimers(); });

  // Invariant: after a drop and reopen nothing is joined until `browsers` arrives, no error is shown, and a browser
  // that stopped meanwhile shows as stopped (not as a NOT_RUNNING alert).
  it('does not join before the list, shows no alert, and shows a browser stopped while down as stopped', () => {
    vi.useFakeTimers();
    FakeWs.all = [];
    goTo('?browser=a');
    const socket = createViewerSocket({ url: 'ws://x/api/ws', viewerId: 'viewer-123456', createSocket: () => new FakeWs() as unknown as WebSocket });
    render(<App socket={socket} />);
    const first = FakeWs.all[0];
    act(() => first.open());
    first.deliver({ type: 'browsers', list: [running('a')] });
    first.deliver(state());
    expect(first.sent.map((m) => m.msg)).toEqual(['hello', 'view']);
    act(() => first.drop());
    act(() => { vi.advanceTimersByTime(500); });
    const second = FakeWs.all[1];
    act(() => second.open());
    expect(second.sent.map((m) => m.msg)).toEqual(['hello']);
    second.deliver({ type: 'browsers', list: [{ ...running('a'), status: 'stopped' }] });
    expect(second.sent.map((m) => m.msg)).toEqual(['hello']);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(statusOf().getAttribute('data-status')).toBe('stopped');
    socket.close();
  });
});

describe('toasts', () => {
  // Invariant: a toast closes itself after TOAST_MS, and hovering pauses that.
  it('auto-dismisses after TOAST_MS and pauses while hovered', async () => {
    vi.useFakeTimers();
    try {
      await openViewer();
      await f.emit({ type: 'error', code: 'NO_TAB', message: 'x' });
      const toast = screen.getByRole('alert');
      fireEvent.mouseEnter(toast);
      act(() => { vi.advanceTimersByTime(TOAST_MS * 2); });
      expect(screen.getByRole('alert')).toBeTruthy();
      fireEvent.mouseLeave(toast);
      act(() => { vi.advanceTimersByTime(TOAST_MS - 1); });
      expect(screen.getByRole('alert')).toBeTruthy();
      act(() => { vi.advanceTimersByTime(1); });
      expect(screen.queryByRole('alert')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  // Invariant: a new toast arriving while the current one is hovered or focused stays up (the hold carries over).
  it('a new toast does not start the timer while the toast is hovered or focused', async () => {
    vi.useFakeTimers();
    try {
      await openViewer();
      for (const hold of ['hover', 'focus'] as const) {
        await f.emit({ type: 'error', code: 'NO_TAB', message: 'first' });
        const toast = screen.getByRole('alert');
        if (hold === 'hover') fireEvent.mouseEnter(toast); else fireEvent.focus(toast);
        await f.emit({ type: 'error', code: 'NO_DIALOG', message: 'second' });
        act(() => { vi.advanceTimersByTime(TOAST_MS * 2); });
        expect(screen.getByRole('alert').textContent).toContain('already closed');
        if (hold === 'hover') fireEvent.mouseLeave(screen.getByRole('alert')); else fireEvent.blur(screen.getByRole('alert'));
        act(() => { vi.advanceTimersByTime(TOAST_MS); });
        expect(screen.queryByRole('alert')).toBeNull();
      }
    } finally { vi.useRealTimers(); }
  });

  // Invariant: a ws error frame with non-string fields shows a toast and does not throw in the handler.
  it('a malformed error frame does not throw', async () => {
    await openViewer();
    await f.emit({ type: 'error', code: 7, message: { x: 1 } } as unknown as ServerMessage);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  // Invariant: a backend message is rendered as text, never markup.
  it('a hostile error message becomes text', async () => {
    await openViewer();
    await f.emit({ type: 'error', code: 'ATTACH_FAILED', message: '<img src=x onerror="window.__pwned=1">' });
    expect(screen.getByRole('alert').textContent).toContain('<img src=x onerror="window.__pwned=1">');
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('browser list layout', () => {
  beforeEach(() => goTo(''));

  // Invariant: each row has one primary action chosen by its state; the rest sit in a keyboard-operable menu.
  it('one primary action per row; the menu closes on Escape and returns focus', async () => {
    const stoppedAttached: BrowserSummary = { ...running('c'), kind: 'attached', status: 'stopped', sandbox: null, attached: { address: '127.0.0.1:9222', via: 'proxy', asksApproval: null } };
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [running('a'), { ...running('b'), status: 'stopped' }, stoppedAttached] });
    const rowOf = (n: string) => within(screen.getByText(n, { selector: 'strong' }).closest('li')!);
    expect(rowOf('a').getByRole('button', { name: 'Open a' })).toBeTruthy();
    expect(rowOf('b').getByRole('button', { name: 'Start b' })).toBeTruthy();
    expect(rowOf('c').getByRole('button', { name: 'Connect c' })).toBeTruthy();
    expect(rowOf('a').getAllByRole('button').map((x) => x.textContent || x.getAttribute('aria-label'))).toEqual(['Open', 'More actions for a']);
    const trigger = screen.getByRole('button', { name: 'More actions for a' });
    fireEvent.click(trigger);
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Stop', 'Delete']);
    expect(document.activeElement?.textContent).toBe('Stop');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' });
    expect(document.activeElement?.textContent).toBe('Delete');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  // Invariant: choosing a menu item that leaves its row in place (Stop) returns focus to the row's menu button, not <body>; Tab closes the menu.
  it('focus returns to the trigger after a menu choice; Tab closes the menu', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [running('a')] });
    pick('a', 'Stop');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More actions for a' }));
    openMenu('a');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  // Invariant: the new-browser field has a visible label and a hint wired to it.
  it('the New browser field is labelled and described by its hint', async () => {
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [] });
    const input = screen.getByLabelText('New browser name');
    expect(input.getAttribute('aria-describedby')).toBe('new-browser-hint');
    expect(document.getElementById('new-browser-hint')?.textContent).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Attach a browser…' }).getAttribute('aria-expanded')).toBe('false');
  });
});

describe('accessibility and focus', () => {
  const focused = (has = true) => vi.spyOn(document, 'hasFocus').mockReturnValue(has);
  const threeTabs = (extra: Partial<BrowserState> = {}) => state({
    controller: { kind: 'human', you: true },
    tabs: [mkTab('T1', 'One'), mkTab('T2', 'Beta'), mkTab('T3', 'Gamma')],
    activeTabId: 'T1',
    ...extra,
  });
  const tabEl = (title: string) => screen.getByRole('tab', { name: new RegExp(title) });
  const sentTabs = () => f.sent.filter((m) => m.msg === 'tab');

  // Invariant: the tablist exposes only tabs: × is hidden from assistive tech, never takes focus, and still closes with the mouse.
  it('tab strip: the tablist exposes only tabs; × is hidden and unfocusable', async () => {
    await openViewer({ kind: 'human', you: true });
    await f.emit(threeTabs());
    expect(within(screen.getByRole('tablist')).queryAllByRole('button')).toEqual([]);
    const closers = document.querySelectorAll<HTMLButtonElement>('.tab-close');
    expect(closers).toHaveLength(3);
    for (const x of closers) {
      expect(x.getAttribute('aria-hidden')).toBe('true');
      expect(x.tabIndex).toBe(-1);
      expect(fireEvent.mouseDown(x)).toBe(false);
    }
    fireEvent.click(screen.getByLabelText('Close tab Beta'));
    expect(sentTabs().at(-1)).toEqual({ msg: 'tab', action: 'close', tabId: 'T2' });
    expect(screen.getByLabelText('Close tab Beta').getAttribute('data-tip')).toContain('Delete');
  });

  // Invariant: Delete on a focused tab closes it only with control, and focus then lands on the tab that took its place.
  it('Delete closes the focused tab and focus moves to its neighbour', async () => {
    focused();
    await openViewer({ kind: 'human', you: true });
    await f.emit(threeTabs());
    tabEl('Beta').focus();
    fireEvent.keyDown(tabEl('Beta'), { key: 'Delete' });
    expect(sentTabs().at(-1)).toEqual({ msg: 'tab', action: 'close', tabId: 'T2' });
    await f.emit(threeTabs({ tabs: [mkTab('T1', 'One'), mkTab('T3', 'Gamma')] }));
    expect(document.activeElement).toBe(tabEl('Gamma'));
    fireEvent.keyDown(tabEl('Gamma'), { key: 'Delete' });
    await f.emit(threeTabs({ tabs: [mkTab('T1', 'One')] }));
    expect(document.activeElement).toBe(tabEl('One'));
  });

  // Invariant: the focus move after a Delete close never happens once the panel has lost focus (the person went elsewhere meanwhile).
  it('the focus move after Delete is skipped when the panel no longer has focus', async () => {
    const has = focused();
    await openViewer({ kind: 'human', you: true });
    await f.emit(threeTabs());
    tabEl('Beta').focus();
    fireEvent.keyDown(tabEl('Beta'), { key: 'Delete' });
    has.mockReturnValue(false);
    document.body.focus();
    await f.emit(threeTabs({ tabs: [mkTab('T1', 'One'), mkTab('T3', 'Gamma')] }));
    expect(document.activeElement).toBe(document.body);
  });

  // Invariant: every tabpanel that renders is labelled by a tab that exists; with no rendered active tab there is no tabpanel.
  it('the screen is a tabpanel only when its tab is rendered', async () => {
    await openViewer({ kind: 'human', you: true });
    await f.emit(threeTabs({ tabs: [], activeTabId: 'T1' }));
    expect(screen.queryByRole('tabpanel')).toBeNull();
    await f.emit(threeTabs({ activeTabId: 'GONE' }));
    expect(screen.queryByRole('tabpanel')).toBeNull();
    await f.emit(threeTabs());
    const panel = screen.getByRole('tabpanel');
    expect(document.getElementById(panel.getAttribute('aria-labelledby')!)).toBeTruthy();
  });

  // Invariant: without control Delete sends nothing.
  it('Delete without control sends nothing', async () => {
    await openViewer({ kind: 'agent' });
    tabEl('One').focus();
    fireEvent.keyDown(tabEl('One'), { key: 'Delete' });
    expect(sentTabs()).toEqual([]);
  });

  // Invariant: every tab advertises Delete, and its description tells the person whether they can use it now.
  it('tabs announce Delete', async () => {
    await openViewer({ kind: 'human', you: true });
    await f.emit(threeTabs());
    const description = () => document.getElementById(tabEl('One').getAttribute('aria-describedby')!)!.textContent!;
    for (const t of screen.getAllByRole('tab')) expect(t.getAttribute('aria-keyshortcuts')).toBe('Delete');
    expect(description()).toMatch(/Press Delete/);
    await f.emit(threeTabs({ controller: { kind: 'agent' } }));
    expect(description()).toMatch(/Take control.*Delete/);
  });

  // Invariant: the screen is the active tab's tabpanel, and the canvas is a named image.
  it('the screen is the active tab’s tabpanel; the canvas is a named image', async () => {
    await openViewer();
    const panel = screen.getByRole('tabpanel', { name: /One/ });
    expect(tabEl('One').getAttribute('aria-controls')).toBe(panel.id);
    expect(screen.getByRole('img', { name: 'Live view of the page' })).toBeTruthy();
  });

  // Invariant: the viewer and the list are each a main landmark headed by an h1.
  it('viewer and list are main landmarks with an h1', async () => {
    await openViewer();
    expect(screen.getByRole('main', { name: 'a' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'a' })).toBeTruthy();
  });

  it('the list is a main landmark with the Code Browser heading', async () => {
    goTo('');
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [running('a')] });
    expect(within(screen.getByRole('main')).getByRole('heading', { level: 1, name: 'Code Browser' })).toBeTruthy();
  });

  // Invariant: opening a browser focuses its heading and going back focuses that browser's row button.
  it('opening a browser focuses its heading; going back focuses its row', async () => {
    focused();
    goTo('');
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [running('a'), running('b')] });
    fireEvent.click(screen.getByRole('button', { name: 'Open a' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to browsers' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open a' }));
  });

  // Invariant: a deep link, an unfocused panel and an arriving dialog never take focus from the host.
  it('a deep link or an unfocused panel never takes focus', async () => {
    focused();
    await openViewer({ kind: 'human', you: true });
    expect(document.activeElement).toBe(document.body);
    vi.restoreAllMocks();
    focused(false);
    goTo('');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await f.emit({ type: 'browsers', list: [running('a')] });
    fireEvent.click(screen.getByRole('button', { name: 'Open a' }));
    expect(document.activeElement).toBe(document.body);
    await f.emit(state({ controller: { kind: 'human', you: true } }));
    await f.emit({ type: 'dialog', tabId: 'T1', dialogType: 'alert', message: 'hi', defaultPrompt: '' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  // Invariant: a page dialog takes focus, makes the rest of the viewer inert, describes itself by its message and hands focus back.
  it('a page dialog takes focus, makes the viewer inert, and gives focus back', async () => {
    focused();
    await openViewer({ kind: 'human', you: true });
    const reload = screen.getByRole('button', { name: 'Reload' });
    reload.focus();
    await f.emit({ type: 'dialog', tabId: 'T1', dialogType: 'confirm', message: 'Sure?', defaultPrompt: '' });
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'OK' }));
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent).toBe('Sure?');
    expect(document.querySelector('header.toolbar')!.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('.viewer-body')!.hasAttribute('inert')).toBe(true);
    await f.emit({ type: 'dialogClosed', tabId: 'T1' });
    expect(document.activeElement).toBe(reload);
    expect(document.querySelector('header.toolbar')!.hasAttribute('inert')).toBe(false);
  });

  it('a prompt dialog focuses its input; without control focus starts on Take control and moves to OK once control is taken', async () => {
    focused();
    await openViewer({ kind: 'human', you: true });
    await f.emit({ type: 'dialog', tabId: 'T1', dialogType: 'prompt', message: 'Name?', defaultPrompt: 'x' });
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Prompt answer' }));
    await f.emit({ type: 'dialogClosed', tabId: 'T1' });
    await f.emit(state({ controller: { kind: 'agent' } }));
    await f.emit({ type: 'dialog', tabId: 'T1', dialogType: 'alert', message: 'hi', defaultPrompt: '' });
    const take = within(screen.getByRole('dialog')).getByRole('button', { name: 'Take control' });
    expect(document.activeElement).toBe(take);
    await f.emit(state({ controller: { kind: 'human', you: true } }));
    expect(document.activeElement).toBe(within(screen.getByRole('dialog')).getByRole('button', { name: 'OK' }));
  });

  // Invariant: an inline confirmation's group is described by its question.
  it('inline confirm describes its question', async () => {
    goTo('');
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [running('a')] });
    pick('a', 'Delete');
    const g = group('Confirm delete');
    expect(document.getElementById(g.getAttribute('aria-describedby')!)!.textContent).toBe('Delete browser "a" and its logins?');
  });

  // Invariant: the reconnect announcement is a persistent live region with one stable phrase per state, not one per retry.
  it('the reconnect live region is always mounted and announces once', async () => {
    stubIdleInstall();
    await openViewer();
    const live = () => screen.getAllByRole('status').find((el) => el.classList.contains('sr-only'))!;
    expect(live().textContent).toBe('');
    await f.status('closed', 2);
    const phrase = live().textContent;
    expect(phrase).toMatch(/Reconnecting/);
    await f.status('connecting', 2);
    await f.status('closed', 3);
    expect(live().textContent).toBe(phrase);
    expect(screen.getByText(/attempt 3/)).toBeTruthy();
    await f.status('open', 0);
    expect(live().textContent).toMatch(/Reconnected/);
  });

  // Invariant: the switcher's result count is announced through a status region that is mounted from the start.
  it('switcher results are announced through a persistent status', async () => {
    await openViewer({ kind: 'human', you: true });
    await f.emit(threeTabs());
    fireEvent.click(screen.getByRole('button', { name: /Search \d+ tabs/ }));
    const dialog = screen.getByRole('dialog', { name: 'Search tabs' });
    const status = within(dialog).getByRole('status');
    expect(status.textContent).toBe('');
    const search = within(dialog).getByRole('combobox');
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(status.textContent).toBe('No tabs match');
    fireEvent.change(search, { target: { value: 'a' } });
    expect(status.textContent).toMatch(/^\d+ tabs? match/);
  });

  // Invariant: a control change is announced in place: the same live node changes its text.
  it('control changes are announced in place', async () => {
    await openViewer({ kind: 'agent' });
    const node = document.querySelector('.controller-bar > [role="status"]')!;
    const before = node.textContent;
    await f.emit(state({ controller: { kind: 'human', you: true } }));
    expect(document.querySelector('.controller-bar > [role="status"]')).toBe(node);
    expect(node.textContent).not.toBe(before);
  });

  // Invariant: every row's primary button has a name that tells the rows apart.
  it('list row actions have distinct names', async () => {
    goTo('');
    const stoppedAttached: BrowserSummary = { ...running('c'), kind: 'attached', status: 'stopped', sandbox: null, attached: { address: '127.0.0.1:9222', via: 'proxy', asksApproval: null } };
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [running('a'), { ...running('b'), status: 'stopped' }, stoppedAttached] });
    for (const name of ['Open a', 'Start b', 'Connect c']) expect(screen.getAllByRole('button', { name })).toHaveLength(1);
  });

  // Invariant: menu items are reached by script (roving), and Home and End jump to the first and last.
  it('row menu items rove', async () => {
    goTo('');
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [running('a')] });
    const menu = openMenu('a');
    const items = within(menu).getAllByRole('menuitem');
    for (const i of items) expect(i.tabIndex).toBe(-1);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items.at(-1));
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
  });
});

describe('Chromium install', () => {
  const NPM = 'npm --prefix /plugin run install-browser';
  const MISSING = { error: `CHROMIUM_NOT_FOUND: No Chromium found\ninstall: ${NPM}`, details: { tried: ['/x/chrome'], install: NPM } };
  const stateOf = (status: string, over: Record<string, unknown> = {}) => ({ status, error: null, exitCode: null, logTail: '', ...over });
  const stopped = (name = 'a'): BrowserSummary => ({ ...running(name), status: 'stopped', sandbox: null });

  // A router over `${method} ${url}`: each key holds a queue of replies; the last one repeats.
  type Reply = { status: number; body: unknown };
  const ok = (body: unknown): Reply => ({ status: 200, body });
  function route(table: Record<string, Reply[]>) {
    const calls: { key: string; init?: RequestInit }[] = [];
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${url}`;
      calls.push({ key, init });
      const queue = table[key];
      if (!queue) throw new Error(`unexpected request ${key}`);
      const r = queue.length > 1 ? queue.shift()! : queue[0];
      return { ok: r.status < 400, status: r.status, json: async () => r.body };
    });
    vi.stubGlobal('fetch', fn);
    return { calls, count: (key: string) => calls.filter((c) => c.key === key).length };
  }
  const INSTALL = 'api/chromium/install';
  const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const notice = (title: RegExp) => screen.getByRole('region', { name: title });

  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  afterEach(() => { vi.useRealTimers(); });

  async function startMissing(table: Record<string, Reply[]>) {
    const r = route({ 'POST api/browsers/a/start': [{ status: 500, body: MISSING }], ...table });
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [stopped()] });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await flush();
    return r;
  }

  // Invariant: a start that fails for want of Chromium offers the install in a notice (no toast), and nothing is
  // installed or requested until the person clicks.
  it('a start failing with CHROMIUM_NOT_FOUND offers Install Chromium and sends nothing yet', async () => {
    const r = await startMissing({});
    expect(within(notice(/Chromium is not installed/)).getByRole('button', { name: 'Install Chromium' })).toBeTruthy();
    expect(within(notice(/Chromium is not installed/)).getByText(NPM)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(r.calls.filter((c) => c.key.includes(INSTALL))).toEqual([]);
  });

  // Invariant: only the not-found-with-install error offers the install; a bad CODE_BROWSER_CHROMIUM path stays a toast.
  it('an override path that points nowhere stays a toast with no install button', async () => {
    await startMissing({ 'POST api/browsers/a/start': [{ status: 500, body: { error: 'CHROMIUM_NOT_FOUND: CODE_BROWSER_CHROMIUM points at a missing file', details: { path: '/nope' } } }] });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Install Chromium' })).toBeNull();
  });

  // Invariant: Install POSTs JSON, then polls the state once per INSTALL_POLL_MS while running and stops when it finishes.
  it('Install posts, polls while running and stops once it succeeds', async () => {
    const r = await startMissing({
      [`POST ${INSTALL}`]: [{ status: 202, body: { install: stateOf('running') } }],
      [`GET ${INSTALL}`]: [ok({ install: stateOf('running', { logTail: 'fetching 10%' }) }), ok({ install: stateOf('succeeded', { exitCode: 0 }) })],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Install Chromium' }));
    await flush();
    const post = r.calls.find((c) => c.key === `POST ${INSTALL}`)!;
    expect((post.init!.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(screen.getByRole('region', { name: /Installing Chromium/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Install Chromium' })).toBeNull();
    expect(r.count(`GET ${INSTALL}`)).toBe(0);
    await tick(INSTALL_POLL_MS);
    expect(r.count(`GET ${INSTALL}`)).toBe(1);
    expect(screen.getByText(/fetching 10%/)).toBeTruthy();
    await tick(INSTALL_POLL_MS);
    expect(r.count(`GET ${INSTALL}`)).toBe(2);
    expect(screen.getByRole('region', { name: /Chromium is installed/ })).toBeTruthy();
    await tick(INSTALL_POLL_MS * 5);
    expect(r.count(`GET ${INSTALL}`)).toBe(2);
  });

  // Invariant: installer output is host-controlled text: it renders as text, never as markup.
  it('a hostile log tail and error render as text', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    await startMissing({
      [`POST ${INSTALL}`]: [{ status: 202, body: { install: stateOf('failed', { error: `boom ${evil}`, exitCode: 1, logTail: evil }) } }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Install Chromium' }));
    await flush();
    const region = notice(/install failed/);
    expect(region.querySelector('img')).toBeNull();
    expect(within(region).getAllByText(new RegExp(evil.replace(/[()]/g, '\\$&'))).length).toBeGreaterThan(0);
  });

  // Invariant: once installed, Start <name> retries the start and, when it works, closes the notice.
  it('after success, Start a starts the browser and closes the notice', async () => {
    const r = await startMissing({
      [`POST ${INSTALL}`]: [{ status: 202, body: { install: stateOf('succeeded', { exitCode: 0 }) } }],
      'POST api/browsers/a/start': [{ status: 500, body: MISSING }, ok({ browser: running('a') })],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Install Chromium' }));
    await flush();
    fireEvent.click(within(notice(/Chromium is installed/)).getByRole('button', { name: 'Start a' }));
    await flush();
    expect(r.count('POST api/browsers/a/start')).toBe(2);
    expect(screen.queryByRole('region', { name: /Chromium/ })).toBeNull();
  });

  // Invariant: a failed install shows why and the log, and Try again posts a new install.
  it('a failed install shows the error and log, and Try again posts again', async () => {
    const r = await startMissing({
      [`POST ${INSTALL}`]: [{ status: 202, body: { install: stateOf('failed', { error: 'the installer exited with code 3', exitCode: 3, logTail: 'network down' }) } }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Install Chromium' }));
    await flush();
    const region = notice(/install failed/);
    expect(within(region).getByText(/exited with code 3/)).toBeTruthy();
    expect(within(region).getByText(/network down/)).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'Try again' }));
    await flush();
    expect(r.count(`POST ${INSTALL}`)).toBe(2);
  });

  // Invariant: a click while an install already runs joins that run (polls it) instead of raising an error.
  it('a 409 INSTALL_RUNNING joins the running install', async () => {
    const r = await startMissing({
      [`POST ${INSTALL}`]: [{ status: 409, body: { error: 'INSTALL_RUNNING: a Chromium install is already running' } }],
      [`GET ${INSTALL}`]: [ok({ install: stateOf('running', { logTail: 'halfway' }) }), ok({ install: stateOf('succeeded', { exitCode: 0 }) })],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Install Chromium' }));
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('region', { name: /Installing Chromium/ })).toBeTruthy();
    expect(screen.getByText(/halfway/)).toBeTruthy();
    await tick(INSTALL_POLL_MS);
    expect(r.count(`GET ${INSTALL}`)).toBe(2);
    expect(screen.getByRole('region', { name: /Chromium is installed/ })).toBeTruthy();
  });

  // Invariant: when the socket opens, the panel asks once; a running install is shown and followed (the reload case).
  it('socket open with an install running shows the notice and polls', async () => {
    const r = route({ [`GET ${INSTALL}`]: [ok({ install: stateOf('running', { logTail: 'resumed' }) }), ok({ install: stateOf('succeeded', { exitCode: 0 }) })] });
    render(<App socket={f.socket} />);
    await f.status('open', 0);
    await flush();
    expect(r.count(`GET ${INSTALL}`)).toBe(1);
    expect(screen.getByRole('region', { name: /Installing Chromium/ })).toBeTruthy();
    await tick(INSTALL_POLL_MS);
    expect(r.count(`GET ${INSTALL}`)).toBe(2);
    expect(screen.getByRole('region', { name: /Chromium is installed/ })).toBeTruthy();
  });

  // Invariant: an idle (or finished) install on socket open shows nothing and is not polled.
  it('socket open with nothing running shows no notice and stops after one GET', async () => {
    const r = route({ [`GET ${INSTALL}`]: [ok({ install: stateOf('idle') })] });
    render(<App socket={f.socket} />);
    await f.status('open', 0);
    await flush();
    await tick(INSTALL_POLL_MS * 5);
    expect(r.count(`GET ${INSTALL}`)).toBe(1);
    expect(screen.queryByRole('region', { name: /Chromium/ })).toBeNull();
  });

  // Invariant: a run that vanishes while followed (backend restarted) is shown as interrupted, not as idle or installed.
  it('running then idle is shown as interrupted', async () => {
    await startMissing({
      [`POST ${INSTALL}`]: [{ status: 202, body: { install: stateOf('running') } }],
      [`GET ${INSTALL}`]: [ok({ install: stateOf('idle') })],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Install Chromium' }));
    await flush();
    await tick(INSTALL_POLL_MS);
    expect(within(notice(/install failed/)).getByText(/interrupted/)).toBeTruthy();
  });

  // Invariant: Create that fails for want of Chromium offers the install and names the new browser for the retry.
  it('Create failing with CHROMIUM_NOT_FOUND shows the notice for the new name', async () => {
    goTo('');
    const r = route({
      'POST api/browsers': [{ status: 500, body: MISSING }],
      'POST api/browsers/fresh/start': [ok({ browser: running('fresh') })],
    });
    render(<App socket={f.socket} />);
    await f.emit({ type: 'browsers', list: [] });
    fireEvent.change(screen.getByLabelText('New browser name'), { target: { value: 'fresh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(within(notice(/Chromium is not installed/)).getByText(/fresh/)).toBeTruthy();
    expect(r.count('POST api/browsers')).toBe(1);
  });
});
