import test from 'node:test';
import assert from 'node:assert/strict';
import { pickPage } from '../src/runCode/pickPage.js';

// A Playwright BrowserContext double: pages with target ids, CDP sessions that report them, newPage that adds one.
function fakeContext(ids) {
  const pages = ids.map((id) => ({ id }));
  const sessions = [];
  return {
    sessions,
    pages: () => [...pages],
    async newCDPSession(page) {
      const s = { detached: false, send: async () => ({ targetInfo: { targetId: page.id } }), detach: async () => { s.detached = true; } };
      sessions.push(s);
      return s;
    },
    async newPage() { const p = { id: 'new' }; pages.push(p); return p; },
  };
}

// Invariant: the active tab (browser_info's activeTargetId) is chosen, in any browser kind, and every CDP session
// opened to find it is detached.
test('the active tab is chosen and the probe sessions are detached', async () => {
  for (const kind of ['launched', 'attached']) {
    const ctx = fakeContext(['A', 'B', 'C']);
    assert.equal((await pickPage(ctx, { activeTargetId: 'B', kind })).id, 'B');
    assert.ok(ctx.sessions.length >= 1 && ctx.sessions.every((s) => s.detached));
  }
});

// Invariant: in an attached browser (the user's own) with no active tab, or one that is gone, the program gets a new tab
// of its own, never one of the user's.
test('attached with no active tab opens its own tab', async () => {
  for (const activeTargetId of [null, 'gone']) {
    const ctx = fakeContext(['U1']);
    assert.equal((await pickPage(ctx, { activeTargetId, kind: 'attached' })).id, 'new');
  }
});

// Invariant: a launched browser with no active tab uses its first tab, and opens one only when it has none.
test('launched with no active tab takes the first tab', async () => {
  assert.equal((await pickPage(fakeContext(['A', 'B']), { activeTargetId: null, kind: 'launched' })).id, 'A');
  assert.equal((await pickPage(fakeContext([]), { activeTargetId: null, kind: 'launched' })).id, 'new');
});
