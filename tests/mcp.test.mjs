import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CodedError } from '../src/errors.js';
import { createMcp } from '../src/mcp.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../conductor.plugin.json', import.meta.url), 'utf8'));

function fakeManager({ controller = 'agent', sandbox = true, refuse = false, attached = null, asksApproval = false } = {}) {
  const state = new Map();
  const grants = [];
  return {
    grants,
    setAllowUnsandboxed: async (...a) => { grants.push(a); },
    list: () => [...state.values()],
    ensure: (n) => { if (!state.has(n)) state.set(n, { name: n, kind: attached ? 'attached' : 'launched', status: 'stopped' }); },
    start: async (n) => {
      if (attached) throw new CodedError('ATTACHED', `'${n}' is the user's own browser, attached in the panel`);
      if (refuse) throw new CodedError('SANDBOX_UNAVAILABLE', `Chromium has no usable sandbox on this host, and browser '${n}' is not allowed to run without one`);
      state.get(n).status = 'running';
    },
    stop: async (n) => { if (!state.has(n)) throw new CodedError('NOT_FOUND', 'no such browser'); state.get(n).status = 'stopped'; },
    info: async (n) => {
      if (state.get(n)?.status !== 'running') throw new CodedError('NOT_RUNNING', `browser '${n}' is stopped`);
      if (attached) {
        return { name: n, kind: 'attached', attached: { address: '127.0.0.1:9222', via: attached, asksApproval }, status: 'running', cdpEndpoint: asksApproval ? 'ws://127.0.0.1:9333/devtools/browser' : 'http://127.0.0.1:9333', controller, sandbox: null, allowUnsandboxed: false, tabs: [{ targetId: 'T1', url: 'https://mail.test/', title: 'Mail', active: false }], activeTargetId: null };
      }
      return { name: n, kind: 'launched', attached: null, status: 'running', cdpEndpoint: 'http://127.0.0.1:9333', controller, sandbox, allowUnsandboxed: false, tabs: [{ targetId: 'T1', url: 'about:blank', title: '', active: true }], activeTargetId: 'T1' };
    },
  };
}
const make = (opts, manager = fakeManager(opts)) => createMcp({ manager, pluginDir: '/plug', pluginId: 'code-browser' });

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

// Invariant: a refused start tells the agent what happened, where the human grants it, and that only the human can;
// the code stays machine-readable.
test('start_browser refused for want of a sandbox points at the panel and says to ask the user', async () => {
  const r = await make({ refuse: true }).handle({ tool: 'start_browser', arguments: { name: 'e2e' } });
  assert.match(r.error, /^SANDBOX_UNAVAILABLE: /);
  assert.ok(r.error.includes('/#plugin/code-browser/?browser=e2e'));
  assert.match(r.error, /Allow without sandbox/);
  assert.match(r.error, /do not add a host/);
  assert.match(r.error, /ask the user/);
  assert.equal(r.text, undefined);
});

// Invariant: no tool argument can grant the opt-in: unknown arguments are ignored and the manager's setter is never reached.
test('an allowUnsandboxed argument changes nothing', async () => {
  const manager = fakeManager({ refuse: true });
  const mcp = make({}, manager);
  for (const tool of ['start_browser', 'browser_info', 'stop_browser', 'list_browsers']) {
    await mcp.handle({ tool, arguments: { name: 'a', allowUnsandboxed: true, allow: true } });
  }
  assert.deepEqual(manager.grants, []);
  assert.deepEqual(mcp.toolNames.sort(), ['browser_info', 'list_browsers', 'start_browser', 'stop_browser']);
});

// Invariant: the read-only opt-in state is visible to the agent in browser_info and list_browsers.
test('browser_info meta carries allowUnsandboxed and list_browsers passes it through', async () => {
  const manager = fakeManager();
  const mcp = make({}, manager);
  manager.ensure('a');
  manager.list()[0].allowUnsandboxed = true;
  await mcp.handle({ tool: 'start_browser', arguments: { name: 'a' } });
  assert.equal((await mcp.handle({ tool: 'browser_info', arguments: { name: 'a' } })).meta.allowUnsandboxed, false);
  assert.equal((await mcp.handle({ tool: 'list_browsers' })).result[0].allowUnsandboxed, true);
});

// Invariant: start_browser on an attached browser is refused with ATTACHED, naming the panel path and telling the
// agent to ask the user to Connect it; nothing is started.
test('start_browser on an attached browser is ATTACHED with the panel path', async () => {
  const manager = fakeManager({ attached: 'proxy' });
  const r = await make({}, manager).handle({ tool: 'start_browser', arguments: { name: 'mine' } });
  assert.match(r.error, /^ATTACHED: /);
  assert.ok(r.error.includes('/#plugin/code-browser/?browser=mine'));
  assert.match(r.error, /ask the user/);
  assert.match(r.error, /Connect/);
  assert.equal(manager.list()[0].status, 'stopped');
});

// Invariant: browser_info on a disconnected attached browser is NOT_RUNNING with text saying it is the user's browser
// and to ask them to Connect it in the panel.
test('browser_info on a stopped attached browser asks for the user to Connect', async () => {
  const manager = fakeManager({ attached: 'direct' });
  manager.ensure('mine');
  const r = await make({}, manager).handle({ tool: 'browser_info', arguments: { name: 'mine' } });
  assert.match(r.error, /^NOT_RUNNING: /);
  assert.match(r.error, /user's own browser/);
  assert.ok(r.error.includes('/#plugin/code-browser/?browser=mine'));
});

// Invariant: browser_info on an attached browser carries kind and attached in meta, the attached note (the user's
// tabs, own tab, stop only disconnects), a snippet that opens its own tab, and stop_browser only disconnects.
test('browser_info on an attached browser: meta, note and own-tab snippet', async () => {
  const manager = fakeManager({ attached: 'proxy' });
  manager.ensure('mine');
  manager.list()[0].status = 'running';
  const mcp = make({}, manager);
  const r = await mcp.handle({ tool: 'browser_info', arguments: { name: 'mine' } });
  assert.equal(r.meta.kind, 'attached');
  assert.deepEqual(r.meta.attached, { address: '127.0.0.1:9222', via: 'proxy', asksApproval: false });
  assert.equal(r.meta.sandbox, null);
  assert.match(r.text, /user's own browser/);
  assert.match(r.text, /Work in your own tab/);
  assert.match(r.text, /stop_browser only disconnects/);
  assert.match(r.text, /context\.newPage\(\); \/\/ your own tab/);
  assert.doesNotMatch(r.text, /Allow remote debugging/);
  assert.deepEqual((await mcp.handle({ tool: 'stop_browser', arguments: { name: 'mine' } })).result, { name: 'mine', status: 'stopped' });
});

// Invariant: when Chrome asks approval per connection, the agent is told to warn the user before each script and the
// snippet waits for the click.
test('an attached browser that asks approval adds the approval note', async () => {
  const manager = fakeManager({ attached: 'direct', asksApproval: true });
  manager.ensure('mine');
  manager.list()[0].status = 'running';
  const r = await make({}, manager).handle({ tool: 'browser_info', arguments: { name: 'mine' } });
  assert.match(r.text, /Allow remote debugging\?/);
  assert.match(r.text, /Tell the user before you run a script/);
  assert.match(r.text, /connectOverCDP\("ws:\/\/127\.0\.0\.1:9333\/devtools\/browser", \{ timeout: \d+ \}\)/);
});
