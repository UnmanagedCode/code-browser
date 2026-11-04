import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTabs, reduceTabs } from '../src/tabs.js';

const run = (events, controller = 'agent', start = emptyTabs()) => events.reduce((s, e) => reduceTabs(s, e, controller), start);
const created = (id, url = 'about:blank') => ({ type: 'created', targetId: id, url, title: '' });
const changed = (id, url) => ({ type: 'changed', targetId: id, url, title: '' });

for (const controller of ['agent', 'human']) {
  // Invariant: a new page target always becomes the active tab, whoever has control.
  test(`a new tab becomes active (${controller} has control)`, () => {
    const s = run([created('A'), created('B')], controller);
    assert.equal(s.activeId, 'B');
    assert.deepEqual(s.tabs.map((t) => t.targetId), ['A', 'B']);
  });

  // Invariant: a title-only change never moves the view.
  test(`a title change on a background tab does not activate it (${controller})`, () => {
    const s = run([created('A'), created('B'), { type: 'changed', targetId: 'A', url: 'about:blank', title: 'new' }], controller);
    assert.equal(s.activeId, 'B');
    assert.equal(s.tabs[0].title, 'new');
  });
}

// Invariant: while the agent has control, navigating a background tab (including same-document) pulls the view to it.
test('a URL change on a background tab activates it only while the agent has control', () => {
  const setup = [created('A'), created('B')];
  assert.equal(run([...setup, changed('A', 'https://x.test/')], 'agent').activeId, 'A');
  assert.equal(run([...setup, changed('A', 'https://x.test/#frag')], 'agent').activeId, 'A');
  assert.equal(run([...setup, changed('A', 'https://x.test/')], 'human').activeId, 'B');
});

// Invariant: a URL change on the already-active tab changes nothing about which tab is active or the MRU order.
test('a URL change on the active tab keeps it active', () => {
  const s = run([created('A'), created('B'), changed('B', 'https://x.test/')]);
  assert.equal(s.activeId, 'B');
  assert.deepEqual(s.mru, ['B', 'A']);
});

// Invariant: closing the active tab activates the most recently used remaining tab.
test('closing the active tab falls back to the MRU tab', () => {
  const s = run([created('A'), created('B'), created('C'), { type: 'activate', targetId: 'A' }, { type: 'activate', targetId: 'C' }, { type: 'destroyed', targetId: 'C' }]);
  assert.equal(s.activeId, 'A');
  assert.deepEqual(s.tabs.map((t) => t.targetId), ['A', 'B']);
});

// Invariant: closing a background tab leaves the active tab alone.
test('closing a background tab keeps the active tab', () => {
  const s = run([created('A'), created('B'), { type: 'destroyed', targetId: 'A' }]);
  assert.equal(s.activeId, 'B');
});

// Invariant: when the last tab closes there is no active tab (the session then opens about:blank).
test('closing the last tab leaves no active tab', () => {
  const s = run([created('A'), { type: 'destroyed', targetId: 'A' }]);
  assert.equal(s.activeId, null);
  assert.deepEqual(s.tabs, []);
});

// Invariant: a viewer's explicit activation wins; unknown ids and unknown events are ignored.
test('activate sets the active tab; unknown ids are ignored', () => {
  const s = run([created('A'), created('B'), { type: 'activate', targetId: 'A' }]);
  assert.equal(s.activeId, 'A');
  assert.equal(reduceTabs(s, { type: 'activate', targetId: 'Z' }, 'agent'), s);
  assert.equal(reduceTabs(s, changed('Z', 'x'), 'agent'), s);
  assert.equal(reduceTabs(s, { type: 'destroyed', targetId: 'Z' }, 'agent'), s);
  assert.equal(reduceTabs(s, created('A'), 'agent'), s, 'a duplicate created event is ignored');
});

// Invariant: a tab created in the background (a person's existing tab in an attached browser) is listed but never
// activated, even when no tab is active; a later foreground tab still becomes active.
test('a background tab is added without becoming active', () => {
  const s = run([{ ...created('U1'), background: true }, { ...created('U2'), background: true }]);
  assert.deepEqual(s.tabs.map((t) => t.targetId), ['U1', 'U2']);
  assert.equal(s.activeId, null);
  assert.deepEqual(s.mru, []);
  assert.equal(run([created('A')], 'agent', s).activeId, 'A');
});

const synced = (...infos) => ({ type: 'synced', infos });

for (const controller of ['agent', 'human']) {
  // Invariant: a swept title lands on the tab without activating anything or touching the MRU order, whoever has control.
  test(`synced sets a background tab's title without activating it (${controller})`, () => {
    const base = run([created('A', 'https://a.test/'), created('B', 'https://b.test/')], controller);
    const s = reduceTabs(base, synced({ targetId: 'A', url: 'https://a.test/', title: 'Fresh' }), controller);
    assert.equal(s.tabs[0].title, 'Fresh');
    assert.equal(s.activeId, 'B');
    assert.deepEqual(s.mru, base.mru);
  });
}

// Invariant: a sweep never owns URL changes (targetInfoChanged does, with the agent-follow rule) and ignores unknown targets.
test('synced ignores unknown ids and entries whose url differs', () => {
  const base = run([created('A', 'https://a.test/')]);
  const s = reduceTabs(base, synced({ targetId: 'Z', url: 'x', title: 't' }, { targetId: 'A', url: 'https://moved.test/', title: 't' }), 'agent');
  assert.equal(s, base);
});

// Invariant: a no-op sync or window event returns the identical state, so the session emits no change.
test('synced and window return the same state when nothing changes', () => {
  const base = reduceTabs(run([created('A', 'https://a.test/')]), { type: 'window', targetId: 'A', windowId: 3 }, 'agent');
  assert.equal(reduceTabs(base, synced({ targetId: 'A', url: 'https://a.test/', title: '' }), 'agent'), base);
  assert.equal(reduceTabs(base, { type: 'window', targetId: 'A', windowId: 3 }, 'agent'), base);
  assert.equal(reduceTabs(base, { type: 'window', targetId: 'Z', windowId: 3 }, 'agent'), base);
});

// Invariant: a tab's window is unknown (null) until a window event sets it.
test('window sets windowId; created tabs start with null', () => {
  const s = run([created('A')]);
  assert.equal(s.tabs[0].windowId, null);
  assert.equal(reduceTabs(s, { type: 'window', targetId: 'A', windowId: 2 }, 'agent').tabs[0].windowId, 2);
});

// Invariant: a target-info change never clears the tab's window (only a `window` event sets it), and one that carries
// nothing new returns the identical state so no viewer is woken.
test('changed keeps windowId and is a no-op when url and title are unchanged', () => {
  const base = reduceTabs(run([created('A', 'https://a.test/')]), { type: 'window', targetId: 'A', windowId: 4 }, 'agent');
  const moved = reduceTabs(base, changed('A', 'https://a.test/next'), 'agent');
  assert.equal(moved.tabs[0].windowId, 4);
  assert.equal(moved.tabs[0].url, 'https://a.test/next');
  assert.equal(reduceTabs(moved, changed('A', 'https://a.test/next'), 'agent'), moved);
});
