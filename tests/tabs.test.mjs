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
