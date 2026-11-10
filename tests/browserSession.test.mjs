import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createBrowserSession, createSessionForEntry } from '../src/browserSession.js';
import { DEFAULT_WINDOW, MAX_PROMPT_TEXT, TAB_SWEEP_MS, VIEWPORT_DEBOUNCE_MS } from '../src/limits.js';
import { fakeClock, liveStack, waitFor } from './helpers.mjs';

let stack;
afterEach(async () => { await stack?.close(); stack = null; });

async function boot() {
  stack = liveStack();
  const session = await stack.start();
  const agent = await stack.agent();
  await waitFor(() => session.snapshot().tabs.length >= 1 && session.snapshot().activeTabId, { what: 'initial tab' });
  return { session, agent };
}
const state = async (agent) => (await agent.send('Fake.getState'));

// Invariant: the session discovers the browser's existing tab and marks it active.
test('discovers the initial tab', async () => {
  const { session } = await boot();
  const snap = session.snapshot();
  assert.equal(snap.tabs.length, 1);
  assert.equal(snap.activeTabId, snap.tabs[0].targetId);
  assert.equal(snap.status, 'running');
});

// Invariant: a tab the agent opens becomes the active tab, and the browser itself is told to activate it.
test('a new tab opened by the agent becomes active', async () => {
  const { session, agent } = await boot();
  const { targetId } = await agent.send('Target.createTarget', { url: 'https://a.test/' });
  await waitFor(() => session.snapshot().activeTabId === targetId, { what: 'new tab to become active' });
  await waitFor(async () => (await state(agent)).activeTarget === targetId, { what: 'Target.activateTarget' });
  assert.equal(session.info().tabs.find((t) => t.active).targetId, targetId);
});

// Invariant: the agent navigating a background tab moves the view to it, but not while a human holds control.
test('tab following honours the controller', async () => {
  const { session, agent } = await boot();
  const first = session.snapshot().activeTabId;
  const { targetId: second } = await agent.send('Target.createTarget', { url: 'about:blank' });
  await waitFor(() => session.snapshot().activeTabId === second, { what: 'second active' });

  session.controller.take('human-viewer');
  await agent.send('Fake.navigateTarget', { targetId: first, url: 'https://human-held.test/' });
  await waitFor(() => session.snapshot().tabs.find((t) => t.targetId === first).url === 'https://human-held.test/', { what: 'url update' });
  assert.equal(session.snapshot().activeTabId, second, 'a human-held browser keeps its view');

  session.controller.release('human-viewer');
  await agent.send('Fake.navigateTarget', { targetId: first, url: 'https://agent-held.test/' });
  await waitFor(() => session.snapshot().activeTabId === first, { what: 'agent navigation to pull the view' });
});

// Invariant: closing the active tab falls back to the previous one; closing the last tab opens about:blank.
test('closing tabs: MRU fallback, and the last tab is replaced by about:blank', async () => {
  const { session, agent } = await boot();
  const first = session.snapshot().activeTabId;
  const { targetId: second } = await agent.send('Target.createTarget', { url: 'https://b.test/' });
  await waitFor(() => session.snapshot().activeTabId === second, { what: 'second active' });
  await session.closeTab(second);
  await waitFor(() => session.snapshot().activeTabId === first, { what: 'fallback to first' });
  await session.closeTab(first);
  await waitFor(() => session.snapshot().tabs.length === 1 && session.snapshot().tabs[0].targetId !== first, { what: 'replacement tab' });
  assert.equal(session.snapshot().tabs[0].url, 'about:blank');
  assert.equal(session.snapshot().activeTabId, session.snapshot().tabs[0].targetId);
});

// Invariant: input goes to the active tab's page session, whichever tab that is.
test('input is dispatched on the active tab', async () => {
  const { session, agent } = await boot();
  const { targetId } = await agent.send('Target.createTarget', { url: 'about:blank' });
  await waitFor(() => session.snapshot().activeTabId === targetId, { what: 'second active' });
  await session.input({ kind: 'mouse', action: 'down', x: 5, y: 6, button: 'left', clickCount: 1 });
  const rec = (await agent.send('Fake.getRecorded')).recorded;
  assert.equal(rec.length, 1);
  assert.equal(rec[0].method, 'Input.dispatchMouseEvent');
  assert.equal(rec[0].targetId, targetId);
  assert.equal(rec[0].params.type, 'mousePressed');
});

// Invariant: goto normalises and navigates the active tab; back/forward walk the history and update canGoBack/canGoForward.
test('navigation: goto, back, forward and history flags', async () => {
  const { session, agent } = await boot();
  const id = session.snapshot().activeTabId;
  await session.navigate('goto', 'example.com');
  await waitFor(() => session.snapshot().tabs[0].url === 'https://example.com/', { what: 'navigation' });
  await waitFor(() => session.snapshot().canGoBack, { what: 'canGoBack' });
  assert.equal(session.snapshot().canGoForward, false);
  await session.navigate('back');
  await waitFor(() => session.snapshot().tabs[0].url === 'about:blank', { what: 'back' });
  await waitFor(() => session.snapshot().canGoForward, { what: 'canGoForward' });
  await session.navigate('forward');
  await waitFor(() => session.snapshot().tabs[0].url === 'https://example.com/', { what: 'forward' });
  assert.equal(session.snapshot().activeTabId, id);
});

// Invariant: a URL the panel may not send never reaches the browser.
test('goto refuses non-http URLs without navigating', async () => {
  const { session } = await boot();
  await waitFor(() => session.snapshot().activeTabId, { what: 'tab' });
  await assert.rejects(session.navigate('goto', 'javascript:alert(1)'), (e) => e.code === 'BAD_URL');
  await assert.rejects(session.navigate('goto', 'file:///etc/passwd'), (e) => e.code === 'BAD_URL');
  assert.equal(session.snapshot().tabs[0].url, 'about:blank');
});

// Invariant: dialogs are surfaced, replayable to late viewers, and answered through the tab's own session.
test('dialog open, pending replay and answer', async () => {
  const { session, agent } = await boot();
  const tabId = session.snapshot().activeTabId;
  await waitFor(async () => (await state(agent)).sessions.length >= 1, { what: 'attached' });
  const seen = [];
  session.events.on('dialog', (d) => seen.push(['open', d]));
  session.events.on('dialogClosed', (d) => seen.push(['closed', d]));
  await agent.send('Fake.openDialog', { targetId: tabId, type: 'prompt', message: 'name?', defaultPrompt: 'x' });
  await waitFor(() => seen.length === 1, { what: 'dialog event' });
  assert.deepEqual(seen[0][1], { tabId, type: 'prompt', message: 'name?', defaultPrompt: 'x' });
  assert.equal(session.pendingDialogs().length, 1);
  await session.answerDialog(tabId, 'accept', 'bob');
  await waitFor(() => seen.length === 2, { what: 'dialogClosed' });
  assert.equal(session.pendingDialogs().length, 0);
  const handled = (await agent.send('Fake.getRecorded')).recorded.find((r) => r.method === 'Page.handleJavaScriptDialog');
  assert.deepEqual(handled.params, { accept: true, promptText: 'bob' });
  await assert.rejects(session.answerDialog(tabId, 'accept'), (e) => e.code === 'NO_DIALOG');
});

// Invariant: a dialog answer's promptText is bounded: longer (or non-string) text is INVALID_INPUT, the dialog stays
// open and nothing reaches the page; text exactly at the cap is accepted.
test('promptText is capped', async () => {
  const { session, agent } = await boot();
  const tabId = session.snapshot().activeTabId;
  await waitFor(async () => (await state(agent)).sessions.length >= 1, { what: 'attached' });
  await agent.send('Fake.openDialog', { targetId: tabId, type: 'prompt', message: 'q' });
  await waitFor(() => session.pendingDialogs().length === 1, { what: 'dialog' });
  for (const bad of ['x'.repeat(MAX_PROMPT_TEXT + 1), 5, { a: 1 }]) {
    await assert.rejects(session.answerDialog(tabId, 'accept', bad), (e) => e.code === 'INVALID_INPUT');
  }
  assert.equal(session.pendingDialogs().length, 1);
  assert.equal((await agent.send('Fake.getRecorded')).recorded.filter((r) => r.method === 'Page.handleJavaScriptDialog').length, 0);
  await session.answerDialog(tabId, 'accept', 'y'.repeat(MAX_PROMPT_TEXT));
  await waitFor(() => session.pendingDialogs().length === 0, { what: 'dialog answered' });
});

// A CDP double whose Target.attachToTarget answers only when the test releases it, so the window between a tab being
// listed and its page session existing is held open deterministically.
function slowAttachCdp({ targets = [], failAttach = false } = {}) {
  const cdp = new EventEmitter();
  cdp.calls = [];
  const waiting = [];
  cdp.release = () => { for (const fn of waiting.splice(0)) fn(); };
  cdp.send = (method, params, { sessionId } = {}) => {
    cdp.calls.push({ method, params, sessionId });
    switch (method) {
      case 'Target.attachToTarget':
        return new Promise((resolve, reject) => waiting.push(() => (failAttach ? reject(new Error('gone')) : resolve({ sessionId: `S-${params.targetId}` }))));
      case 'Target.getTargets': return Promise.resolve({ targetInfos: targets });
      case 'Page.getNavigationHistory': return Promise.resolve({ currentIndex: 0, entries: [{ id: 0, url: 'about:blank' }] });
      default: return Promise.resolve({});
    }
  };
  cdp.created = (targetId) => cdp.emit('event', { method: 'Target.targetCreated', params: { targetInfo: { targetId, type: 'page', url: 'about:blank', title: '' } } });
  return cdp;
}
const click = { kind: 'mouse', action: 'down', x: 1, y: 1, button: 'left', clickCount: 1 };

// Invariant: a tab the session reports as active is usable: input and navigation sent while its page session is still
// being attached wait for it and then go to that tab's session, never failing with NO_TAB.
test('input and navigation on a listed tab wait for its attach', async () => {
  const cdp = slowAttachCdp();
  const session = createBrowserSession({ name: 'a', cdp, sandbox: true, log: { warn() {} } });
  await session.start();
  cdp.created('T1');
  assert.equal(session.snapshot().activeTabId, 'T1');
  const input = session.input(click);
  const nav = session.navigate('goto', 'https://x.test/');
  await new Promise((r) => setImmediate(r));
  assert.ok(!cdp.calls.some((c) => c.method === 'Input.dispatchMouseEvent'), 'nothing is sent before the attach');
  cdp.release();
  await Promise.all([input, nav]);
  assert.equal(cdp.calls.find((c) => c.method === 'Input.dispatchMouseEvent').sessionId, 'S-T1');
  assert.equal(cdp.calls.find((c) => c.method === 'Page.navigate').sessionId, 'S-T1');
});

// Invariant: in an attached browser the seeded tabs are listed while their attaches are in flight, and selecting one
// and acting on it waits for its attach too.
test('a seeded tab of an attached browser is usable as soon as it is selected', async () => {
  const cdp = slowAttachCdp({ targets: [{ targetId: 'U1', type: 'page', url: 'https://mail.test/', title: 'Mail' }] });
  const session = createBrowserSession({ name: 'a', cdp, sandbox: null, attached: true, log: { warn() {} } });
  await session.start();
  session.activateTab('U1');
  const input = session.input(click);
  cdp.release();
  await input;
  assert.equal(cdp.calls.find((c) => c.method === 'Input.dispatchMouseEvent').sessionId, 'S-U1');
});

// Invariant: a tab whose attach fails is reported as NO_TAB to whoever was waiting on it, not left hanging.
test('a failed attach makes waiting actions NO_TAB', async () => {
  const cdp = slowAttachCdp({ failAttach: true });
  const session = createBrowserSession({ name: 'a', cdp, sandbox: true, log: { warn() {} } });
  await session.start();
  cdp.created('T1');
  const input = session.input(click);
  cdp.release();
  await assert.rejects(input, (e) => e.code === 'NO_TAB');
});

// Invariant: the session's own navigation refresh for a new active tab never races that tab's attach: no NO_TAB (or
// any) warning is logged for a tab the session lists, and the refresh reaches the tab's session once attached.
test('a new tab logs no warning and its navigation state is read through its session', async () => {
  const cdp = slowAttachCdp();
  const warns = [];
  const session = createBrowserSession({ name: 'a', cdp, sandbox: true, log: { warn: (m) => warns.push(m) } });
  await session.start();
  cdp.created('T1');
  await new Promise((r) => setImmediate(r));
  cdp.release();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(warns, []);
  assert.ok(cdp.calls.some((c) => c.method === 'Page.getNavigationHistory' && c.sessionId === 'S-T1'));
});

// Invariant: events on sessions the backend did not open (CDP relay clients share the connection) change nothing the
// panel sees: no tab appears or disappears and no dialog opens; the backend's own page sessions still count.
test('events of foreign sessions leave tabs and dialogs alone', async () => {
  const cdp = slowAttachCdp();
  const session = createBrowserSession({ name: 'a', cdp, sandbox: true, log: { warn() {} } });
  await session.start();
  cdp.created('T1');
  cdp.release();
  await waitFor(() => session.ownsSession('S-T1'), { what: 'the attach' });
  const dialogs = [];
  session.events.on('dialog', (d) => dialogs.push(d));
  const before = session.snapshot();
  cdp.emit('event', { method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T2', type: 'page', url: 'about:blank', title: '' } }, sessionId: 'agent-root' });
  cdp.emit('event', { method: 'Target.targetDestroyed', params: { targetId: 'T1' }, sessionId: 'agent-root' });
  cdp.emit('event', { method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'x' }, sessionId: 'agent-page' });
  assert.deepEqual(session.snapshot(), before);
  assert.deepEqual(dialogs, []);
  assert.equal(session.ownsSession('agent-root'), false);
  cdp.emit('event', { method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'mine' }, sessionId: 'S-T1' });
  assert.deepEqual(dialogs.map((d) => d.message), ['mine'], "the backend's own session still reaches the panel");
});

// ---- title sweep, window ids and recency (the sweep runs on an injected clock) ----
const SWEEP = TAB_SWEEP_MS;
async function bootClocked() {
  const clock = fakeClock();
  stack = liveStack({ clock });
  const session = await stack.start();
  const agent = await stack.agent();
  await waitFor(() => session.snapshot().activeTabId && session.snapshot().tabs[0].windowId !== null, { what: 'initial tab and window' });
  return { session, agent, clock };
}

// Invariant: Chromium announces no title commit, so a changed title shows in the snapshot only after the next sweep.
test('a title set without an event reaches the snapshot on the next sweep', async () => {
  const { session, agent, clock } = await bootClocked();
  const id = session.snapshot().activeTabId;
  await agent.send('Fake.setTitle', { targetId: id, title: 'Hello' });
  assert.equal(session.snapshot().tabs[0].title, '');
  clock.advance(SWEEP);
  await waitFor(() => session.snapshot().tabs[0].title === 'Hello', { what: 'swept title' });
});

// Invariant: a sweep updates titles only: it never moves the active tab, even for the agent.
test('a swept title change on a background tab keeps the active tab', async () => {
  const { session, agent, clock } = await bootClocked();
  const first = session.snapshot().activeTabId;
  const { targetId: second } = await agent.send('Target.createTarget', { url: 'about:blank' });
  await waitFor(() => session.snapshot().activeTabId === second, { what: 'second active' });
  await agent.send('Fake.setTitle', { targetId: first, title: 'Background' });
  clock.advance(SWEEP);
  await waitFor(() => session.snapshot().tabs.find((t) => t.targetId === first).title === 'Background', { what: 'swept title' });
  assert.equal(session.snapshot().activeTabId, second);
});

// Invariant: every tab carries its window id, and a tab opened in a new window gets a different one.
test('tabs carry window ids', async () => {
  const { session, agent } = await bootClocked();
  const { targetId } = await agent.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  await waitFor(() => session.snapshot().tabs.find((t) => t.targetId === targetId)?.windowId, { what: 'window of new tab' });
  const [a, b] = session.snapshot().tabs;
  assert.equal(typeof a.windowId, 'number');
  assert.notEqual(a.windowId, b.windowId);
});

// Invariant: recentTabIds is the most-recently-used order of existing tabs only.
test('recentTabIds follows activations and drops closed tabs', async () => {
  const { session, agent } = await bootClocked();
  const first = session.snapshot().activeTabId;
  const { targetId: second } = await agent.send('Target.createTarget', { url: 'about:blank' });
  await waitFor(() => session.snapshot().activeTabId === second, { what: 'second active' });
  assert.deepEqual(session.snapshot().recentTabIds, [second, first]);
  session.activateTab(first);
  assert.deepEqual(session.snapshot().recentTabIds, [first, second]);
  await session.closeTab(second);
  await waitFor(() => session.snapshot().tabs.length === 1, { what: 'closed' });
  assert.deepEqual(session.snapshot().recentTabIds, [first]);
});

// Invariant: a sweep that changes nothing emits no 'change' (one sweep a second must not wake every viewer).
test('a sweep with nothing new emits no change', async () => {
  const { session, clock } = await bootClocked();
  await new Promise((r) => setTimeout(r, 30));
  let changes = 0;
  session.events.on('change', () => { changes += 1; });
  clock.advance(SWEEP);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(changes, 0);
});

// Invariant: a disposed session runs no more sweeps and leaves no timer pending.
test('dispose cancels the sweep', async () => {
  const { session, clock } = await bootClocked();
  assert.equal(clock.pending() > 0, true, 'a sweep is scheduled');
  session.dispose();
  assert.equal(clock.pending(), 0);
});

// A CDP double that answers Target.getTargets and Browser.getWindowForTarget from a fixed list.
function listCdp(targets) {
  const cdp = new EventEmitter();
  cdp.calls = [];
  cdp.send = (method, params) => {
    cdp.calls.push({ method, params });
    switch (method) {
      case 'Target.getTargets': return Promise.resolve({ targetInfos: targets });
      case 'Browser.getWindowForTarget': return Promise.resolve({ windowId: params.targetId === 'U2' ? 7 : 3 });
      case 'Target.attachToTarget': return Promise.resolve({ sessionId: `S-${params.targetId}` });
      default: return Promise.resolve({});
    }
  };
  return cdp;
}

// Invariant: in an attached browser the person's seeded tabs get window ids, and swept titles, without becoming active.
test('seeded tabs of an attached browser get windows and swept titles', async () => {
  const targets = [
    { targetId: 'U1', type: 'page', url: 'https://a.test/', title: 'a.test' },
    { targetId: 'U2', type: 'page', url: 'https://b.test/', title: 'B' },
  ];
  const cdp = listCdp(targets);
  const clock = fakeClock();
  const session = createBrowserSession({ name: 'a', cdp, sandbox: null, attached: true, log: { warn() {} }, sweep: { schedule: clock.schedule } });
  await session.start();
  await waitFor(() => session.snapshot().tabs.every((t) => t.windowId !== null), { what: 'window ids' });
  assert.deepEqual(session.snapshot().tabs.map((t) => t.windowId), [3, 7]);
  targets[0] = { ...targets[0], title: 'Mail' };
  clock.advance(SWEEP);
  await waitFor(() => session.snapshot().tabs[0].title === 'Mail', { what: 'swept title' });
  assert.equal(session.snapshot().activeTabId, null);
  session.dispose();
});

// Invariant: a failing sweep is logged and the next one still runs.
test('a failed sweep is logged and the loop continues', async () => {
  const cdp = listCdp([]);
  let fail = true;
  const send = cdp.send;
  cdp.send = (method, params) => (method === 'Target.getTargets' && fail && cdp.calls.some((c) => c.method === 'Target.setDiscoverTargets') ? (fail = false, Promise.reject(new Error('boom'))) : send(method, params));
  const warns = [];
  const clock = fakeClock();
  const session = createBrowserSession({ name: 'a', cdp, sandbox: true, log: { warn: (m) => warns.push(m) }, sweep: { schedule: clock.schedule } });
  await session.start();
  clock.advance(SWEEP);
  await waitFor(() => warns.length === 1 && clock.pending() === 1, { what: 'warning and a rescheduled sweep' });
  assert.match(warns[0], /tab sweep: boom/);
  session.dispose();
});

// Invariant: disposing while a sweep's Target.getTargets is still pending means no change is emitted when it answers and
// no further sweep is scheduled.
test('dispose while a sweep is in flight neither applies it nor reschedules', async () => {
  const targets = [{ targetId: 'T1', type: 'page', url: 'https://a.test/', title: '' }];
  const cdp = listCdp(targets);
  let release;
  const send = cdp.send;
  let held = false;
  cdp.send = (method, params) => {
    if (method === 'Target.getTargets' && held) return new Promise((resolve) => { release = () => resolve({ targetInfos: [{ ...targets[0], title: 'Late' }] }); });
    return send(method, params);
  };
  const clock = fakeClock();
  const session = createBrowserSession({ name: 'a', cdp, sandbox: true, log: { warn() {} }, sweep: { schedule: clock.schedule } });
  await session.start();
  cdp.emit('event', { method: 'Target.targetCreated', params: { targetInfo: targets[0] } });
  await waitFor(() => session.snapshot().tabs[0]?.windowId !== null, { what: 'tab and window' });
  held = true;
  clock.advance(SWEEP);
  await waitFor(() => release, { what: 'the sweep to be in flight' });
  let changes = 0;
  session.events.on('change', () => { changes += 1; });
  session.dispose();
  release();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(changes, 0);
  assert.equal(session.snapshot().tabs[0].title, '');
  assert.equal(clock.pending(), 0);
});

const tick = () => new Promise((r) => setImmediate(r));
const viewer = (maxWidth, maxHeight) => ({ send() {}, bufferedAmount: () => 0, maxWidth, maxHeight });
const resizeCommand = /^Emulation\.|^Browser\.(setWindowBounds|setContentsSize)$/;

// Invariant: a launched browser's tab gets the default viewport on attach, then the panel's aspect after the debounce.
test('a launched session fits the viewport to the viewer', async () => {
  const clock = fakeClock();
  const cdp = slowAttachCdp();
  const session = createBrowserSession({ name: 'a', cdp, sandbox: true, attached: false, log: { warn() {} }, viewportOptions: { schedule: clock.schedule } });
  await session.start();
  cdp.created('T1');
  cdp.release();
  await tick();
  const overrides = () => cdp.calls.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride');
  assert.deepEqual(overrides().map((c) => [c.sessionId, c.params.width, c.params.height]), [['S-T1', DEFAULT_WINDOW.width, DEFAULT_WINDOW.height]]);
  session.screencast.addViewer('v', viewer(1280, 676));
  clock.advance(VIEWPORT_DEBOUNCE_MS);
  assert.deepEqual(overrides().map((c) => c.params.height), [DEFAULT_WINDOW.height, 676]);
  session.dispose();
});

// Invariant (owner requirement): an attached browser never receives an emulation, window-size or content-size command,
// whatever the panel does.
test('an attached session never sends a resize or emulation command', async () => {
  const clock = fakeClock();
  const cdp = slowAttachCdp({ targets: [{ targetId: 'U1', type: 'page', url: 'https://mail.test/', title: 'Mail' }] });
  const session = createBrowserSession({ name: 'a', cdp, sandbox: null, attached: true, log: { warn() {} }, viewportOptions: { schedule: clock.schedule }, sweep: { schedule: clock.schedule } });
  await session.start();
  session.activateTab('U1');
  cdp.release();
  await tick();
  session.screencast.addViewer('v', viewer(1280, 676));
  clock.advance(VIEWPORT_DEBOUNCE_MS * 2);
  session.screencast.updateViewer('v', { maxWidth: 800, maxHeight: 1200 });
  clock.advance(VIEWPORT_DEBOUNCE_MS * 2);
  session.screencast.updateViewer('v', { maxWidth: 1920, maxHeight: 1014 });
  clock.advance(VIEWPORT_DEBOUNCE_MS * 2);
  session.screencast.removeViewer('v');
  clock.advance(VIEWPORT_DEBOUNCE_MS * 2);
  assert.ok(cdp.calls.some((c) => c.method === 'Page.startScreencast'), 'the screencast did run');
  assert.deepEqual(cdp.calls.filter((c) => resizeCommand.test(c.method)), []);
  session.dispose();
});

// Invariant: the session factory treats anything not positively `launched` as a person's own browser (no viewport fit).
test('createSessionForEntry resizes only entries of kind launched', async () => {
  for (const [kind, resized] of [['launched', true], ['attached', false], ['mystery', false], [undefined, false]]) {
    const cdp = slowAttachCdp();
    const session = createSessionForEntry({ name: 'a', kind, cdp, sandbox: true }, { log: { warn() {} } });
    await session.start();
    cdp.created('T1');
    cdp.release();
    await tick();
    assert.equal(cdp.calls.some((c) => c.method === 'Emulation.setDeviceMetricsOverride'), resized, `kind ${kind}`);
    session.dispose();
  }
});

// Invariant: resize and emulation commands exist only in src/viewportFit.js, which only browserSession.js imports.
test('source guard: only viewportFit.js sends resize commands', () => {
  const srcDir = new URL('../src/', import.meta.url).pathname;
  const files = fs.readdirSync(srcDir, { recursive: true }).filter((f) => f.endsWith('.js'));
  const sink = /Emulation\.|setWindowBounds|setContentsSize/;
  assert.deepEqual(files.filter((f) => sink.test(fs.readFileSync(path.join(srcDir, f), 'utf8'))), ['viewportFit.js']);
  const importers = files.filter((f) => /viewportFit\.js/.test(fs.readFileSync(path.join(srcDir, f), 'utf8')) && f !== 'viewportFit.js');
  assert.deepEqual(importers, ['browserSession.js']);
});
