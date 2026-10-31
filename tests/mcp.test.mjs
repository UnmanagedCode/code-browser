import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CodedError } from '../src/errors.js';
import { createMcp } from '../src/mcp.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../conductor.plugin.json', import.meta.url), 'utf8'));

function fakeManager({ controller = 'agent', sandbox = true } = {}) {
  const state = new Map();
  return {
    list: () => [...state.values()],
    ensure: (n) => { if (!state.has(n)) state.set(n, { name: n, status: 'stopped' }); },
    start: async (n) => { state.get(n).status = 'running'; },
    stop: async (n) => { if (!state.has(n)) throw new CodedError('NOT_FOUND', 'no such browser'); state.get(n).status = 'stopped'; },
    info: async (n) => {
      if (state.get(n)?.status !== 'running') throw new CodedError('NOT_RUNNING', `browser '${n}' is stopped`);
      return { name: n, status: 'running', cdpEndpoint: 'http://127.0.0.1:9333', controller, sandbox, tabs: [{ targetId: 'T1', url: 'about:blank', title: '', active: true }], activeTargetId: 'T1' };
    },
  };
}
const make = (opts) => createMcp({ manager: fakeManager(opts), pluginDir: '/plug', pluginId: 'code-browser' });

// Invariant: the manifest advertises exactly the tools the handler serves, so no tool is declared but dead.
test('manifest tool names equal the handler keys', () => {
  assert.deepEqual(manifest.mcp.tools.map((t) => t.name).sort(), make().toolNames.slice().sort());
});

// Invariant: every failure mode is a normal {error} body (the route answers HTTP 200); handle never throws.
test('handle never throws: unknown tools, bad names and bad bodies become {error}', async () => {
  const mcp = make();
  assert.match((await mcp.handle({ tool: 'nope' })).error, /^UNKNOWN_TOOL/);
  assert.match((await mcp.handle({ tool: 'constructor' })).error, /^UNKNOWN_TOOL/);
  assert.match((await mcp.handle({})).error, /^UNKNOWN_TOOL/);
  assert.match((await mcp.handle({ tool: 'start_browser', arguments: { name: '../x' } })).error, /^INVALID_NAME/);
  assert.match((await mcp.handle({ tool: 'browser_info', arguments: { name: 'a' } })).error, /^NOT_RUNNING/);
  assert.match((await mcp.handle({ tool: 'stop_browser', arguments: { name: 'ghost' } })).error, /^NOT_FOUND/);
});

// Invariant: name is optional everywhere and defaults to "default".
test('name defaults to "default"', async () => {
  const mcp = make();
  const r = await mcp.handle({ tool: 'start_browser' });
  assert.equal(r.meta.name, 'default');
  assert.equal((await mcp.handle({ tool: 'list_browsers' })).result[0].name, 'default');
  assert.deepEqual((await mcp.handle({ tool: 'stop_browser', arguments: {} })).result, { name: 'default', status: 'stopped' });
});

// Invariant: browser_info returns meta (state + host-relative panelPath) and text (relative-address note, rules, runnable snippet).
test('start_browser/browser_info return {text, meta} with panelPath, note, rules and snippet', async () => {
  const mcp = make();
  const started = await mcp.handle({ tool: 'start_browser', arguments: { name: 'e2e' } });
  const info = await mcp.handle({ tool: 'browser_info', arguments: { name: 'e2e' } });
  for (const r of [started, info]) {
    assert.equal(r.meta.panelPath, '/#plugin/code-browser/?browser=e2e');
    assert.equal(r.meta.cdpEndpoint, 'http://127.0.0.1:9333');
    assert.equal(r.meta.controller, 'agent');
    assert.deepEqual(r.meta.tabs.map((t) => t.targetId), ['T1']);
    assert.ok(r.text.includes('/#plugin/code-browser/?browser=e2e'));
    assert.match(r.text, /relative to the address the user opens cc at/);
    assert.match(r.text, /Do not add a host/);
    assert.match(r.text, /never `newContext\(\)`/);
    assert.match(r.text, /only disconnects/);
    assert.ok(r.text.includes('createRequire("/plug/package.json")'));
    assert.doesNotMatch(r.text, /Do not drive it/);
  }
});

// Invariant: while a human holds control the result tells the agent to stand down.
test('a human controller adds the do-not-drive note', async () => {
  const mcp = make({ controller: 'human' });
  await mcp.handle({ tool: 'start_browser', arguments: { name: 'a' } });
  const info = await mcp.handle({ tool: 'browser_info', arguments: { name: 'a' } });
  assert.equal(info.meta.controller, 'human');
  assert.match(info.text, /human currently has control/);
  assert.match(info.text, /Call browser_info again later/);
});

// Invariant: an agent is told when the browser runs without Chromium's sandbox, in both tools that hand out the snippet,
// and only then.
test('sandbox false adds a one-line warning; sandbox true does not', async () => {
  for (const sandbox of [false, true]) {
    const mcp = make({ sandbox });
    const started = await mcp.handle({ tool: 'start_browser', arguments: { name: 'a' } });
    const info = await mcp.handle({ tool: 'browser_info', arguments: { name: 'a' } });
    for (const r of [started, info]) {
      assert.equal(r.meta.sandbox, sandbox);
      const warned = /WARNING: .*without Chromium's sandbox/.test(r.text);
      assert.equal(warned, !sandbox, `sandbox=${sandbox}`);
      if (!sandbox) {
        assert.equal(r.text.split('\n').filter((l) => /sandbox/i.test(l) && l.startsWith('WARNING')).length, 1);
        assert.match(r.text, /untrusted pages/);
      }
    }
  }
});
