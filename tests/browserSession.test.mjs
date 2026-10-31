import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PROMPT_TEXT } from '../src/limits.js';
import { liveStack, waitFor } from './helpers.mjs';

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
  await waitFor(async () => (await state(agent)).sessions.length >= 2, { what: 'both tabs attached' });
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
  await waitFor(async () => (await state(agent)).sessions.length >= 1, { what: 'attached' });
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
