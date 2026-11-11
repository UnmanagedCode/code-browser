import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pluginDir } from '../src/config.js';
import { createHelperInfo } from '../src/helperInfo.js';
import { ensureRelayToken, relayTokenFile } from '../src/relayToken.js';
import { tmpDir } from './helpers.mjs';
import { createMcp } from '../src/mcp.js';
import { buildSnippet } from '../src/snippet.js';
import { call } from './_mcpCall.mjs';
import { fakeManager, testHelperInfo } from './fakes/fakeMcpManager.mjs';

const manifest = JSON.parse(fs.readFileSync(new URL('../conductor.plugin.json', import.meta.url), 'utf8'));
const make = (opts, manager = fakeManager(opts)) => createMcp({ manager, pluginDir: '/plug', pluginId: 'code-browser', helperInfo: testHelperInfo });
const PANEL_E2E = '/#plugin/code-browser/?browser=e2e';

// Invariant: the manifest advertises exactly the tools the handler serves, so no tool is declared but dead.
test('manifest tool names equal the handler keys', () => {
  assert.deepEqual(manifest.mcp.tools.map((t) => t.name).sort(), make().toolNames.slice().sort());
});

// Invariant: name is optional everywhere and defaults to "default", in both formats.
test('name defaults to "default"', async () => {
  const mcp = make();
  assert.equal((await call(mcp, 'start_browser', {}, 'text')).meta.name, 'default');
  assert.equal((await call(mcp, 'start_browser', {}, 'json')).structured.name, 'default');
  assert.equal((await call(mcp, 'list_browsers', {}, 'json')).structured.browsers[0].name, 'default');
  assert.deepEqual((await call(mcp, 'stop_browser', {}, 'json')).structured, { name: 'default', kind: 'launched', status: 'stopped' });
});

// Invariant: a request with no `format` is answered as text (an older cc sends none), the same as format "text".
test('an absent format is text', async () => {
  const mcp = make();
  await call(mcp, 'start_browser', { name: 'a' }, 'text');
  assert.deepEqual(await call(mcp, 'browser_info', { name: 'a' }), await call(mcp, 'browser_info', { name: 'a' }, 'text'));
});

// Invariant: start_browser/browser_info json is the complete data (state, panelPath, rules, whole snippet); the text
// view carries the same panel path, relative-address note, rules and runnable snippet, plus today's meta.
test('start_browser/browser_info: json data and text view agree', async () => {
  const mcp = make();
  const started = await call(mcp, 'start_browser', { name: 'e2e' }, 'text');
  const info = await call(mcp, 'browser_info', { name: 'e2e' }, 'text');
  for (const r of [started, info]) {
    assert.equal(r.meta.panelPath, PANEL_E2E);
    assert.equal(r.meta.cdpEndpoint, 'http://127.0.0.1:9333');
    assert.equal(r.meta.controller, 'agent');
    assert.deepEqual(r.meta.tabs.map((t) => t.targetId), ['T1']);
    assert.deepEqual(Object.keys(r.meta), ['name', 'kind', 'status', 'attached', 'cdpEndpoint', 'controller', 'sandbox', 'allowUnsandboxed', 'tabs', 'panelPath', 'helper']);
    assert.deepEqual(r.meta.helper, testHelperInfo('e2e'));
    assert.ok(r.text.includes('In run_code: const { page } = await cc.code_browser.connect({ name: "e2e" });'));
    assert.ok(r.text.includes(PANEL_E2E));
    assert.match(r.text, /relative to the address the user opens cc at/);
    assert.match(r.text, /Do not add a host/);
    assert.match(r.text, /never `newContext\(\)`/);
    assert.match(r.text, /only disconnects/);
    assert.match(r.text, /Read innerHeight/);
    assert.ok(r.text.includes('createRequire("/plug/package.json")'));
    assert.doesNotMatch(r.text, /Do not drive it/);
  }
  const started2 = await call(mcp, 'start_browser', { name: 'e2e' }, 'json');
  const d = (await call(mcp, 'browser_info', { name: 'e2e' }, 'json')).structured;
  assert.deepEqual(started2.structured, d);
  assert.equal(d.panelPath, PANEL_E2E);
  assert.equal(d.snippet, buildSnippet({ pluginDir: '/plug', cdpEndpoint: 'http://127.0.0.1:9333', activeTargetId: 'T1' }));
  assert.deepEqual(d.helper, testHelperInfo('e2e'));
  assert.ok(d.rules.some((r) => /never `newContext\(\)`/.test(r)) && d.rules.some((r) => /viewport is \d+ px wide/.test(r)));
  assert.deepEqual(d.notes, []);
  assert.ok(info.text.includes(`\`\`\`js\n${d.snippet.trimEnd()}\n\`\`\``), 'text fences the same snippet');
});

// Invariant: while a human holds control the result tells the agent to stand down: in text prose and in `notes`.
test('a human controller adds the do-not-drive note', async () => {
  const mcp = make({ controller: 'human' });
  await call(mcp, 'start_browser', { name: 'a' }, 'text');
  const info = await call(mcp, 'browser_info', { name: 'a' }, 'text');
  assert.equal(info.meta.controller, 'human');
  assert.match(info.text, /human currently has control/);
  assert.match(info.text, /Call browser_info again later/);
  const d = (await call(mcp, 'browser_info', { name: 'a' }, 'json')).structured;
  assert.equal(d.controller, 'human');
  assert.equal(d.notes.length, 1);
  assert.match(d.notes[0], /Call browser_info again later/);
});

// Invariant: an agent is told when the browser runs without Chromium's sandbox, in both tools that hand out the snippet,
// in both formats, and only then.
test('sandbox false adds a one-line warning; sandbox true does not', async () => {
  for (const sandbox of [false, true]) {
    const mcp = make({ sandbox });
    for (const tool of ['start_browser', 'browser_info']) {
      const r = await call(mcp, tool, { name: 'a' }, 'text');
      assert.equal(r.meta.sandbox, sandbox);
      assert.equal(/WARNING: .*without Chromium's sandbox/.test(r.text), !sandbox, `sandbox=${sandbox}`);
      if (!sandbox) {
        assert.equal(r.text.split('\n').filter((l) => /sandbox/i.test(l) && l.startsWith('WARNING')).length, 1);
        assert.match(r.text, /untrusted pages/);
      }
      const d = (await call(mcp, tool, { name: 'a' }, 'json')).structured;
      assert.equal(d.sandbox, sandbox);
      assert.equal(d.notes.some((n) => /without Chromium's sandbox/.test(n)), !sandbox);
    }
  }
});

// Invariant: a refused start tells the agent what happened and that only the human can lift it; the panel path is in
// details (not the message), and the code is machine-readable; no tool result carries text.
test('start_browser refused for want of a sandbox: code, details.panelPath, ask the user', async () => {
  for (const format of ['text', 'json']) {
    const r = await call(make({ refuse: true }), 'start_browser', { name: 'e2e' }, format);
    assert.equal(r.code, 'SANDBOX_UNAVAILABLE');
    assert.deepEqual(r.details, { name: 'e2e', panelPath: PANEL_E2E });
    assert.ok(!r.error.includes('/#plugin'));
    assert.match(r.error, /Allow without sandbox/);
    assert.match(r.error, /do not add a host/);
    assert.match(r.error, /ask the user/);
    assert.equal(r.text, undefined);
    assert.equal(r.structured, undefined);
  }
});

// Invariant: no tool argument can grant the opt-in: unknown arguments are ignored and the manager's setter is never reached.
test('an allowUnsandboxed argument changes nothing', async () => {
  const manager = fakeManager({ refuse: true });
  const mcp = make({}, manager);
  for (const format of ['text', 'json']) {
    for (const tool of ['start_browser', 'browser_info', 'stop_browser', 'list_browsers']) {
      await call(mcp, tool, { name: 'a', allowUnsandboxed: true, allow: true }, format);
    }
  }
  assert.deepEqual(manager.grants, []);
  assert.deepEqual(mcp.toolNames.sort(), ['browser_info', 'list_browsers', 'start_browser', 'stop_browser']);
});

// Invariant: the read-only opt-in state is visible to the agent in browser_info and list_browsers, in json and in the text listing.
test('allowUnsandboxed is reported by list_browsers, not changed by browser_info', async () => {
  const manager = fakeManager();
  const mcp = make({}, manager);
  manager.ensure('a');
  manager.list()[0].allowUnsandboxed = true;
  await call(mcp, 'start_browser', { name: 'a' }, 'json');
  assert.equal((await call(mcp, 'list_browsers', {}, 'json')).structured.browsers[0].allowUnsandboxed, true);
  assert.match((await call(mcp, 'list_browsers', {}, 'text')).text, /allowUnsandboxed true/);
});

// Invariant: the text listing is prose that names the json fields, says how to proceed, and flags what needs attention.
test('list_browsers text: empty hint, one line per browser with json field names, extras only when they apply', async () => {
  const manager = fakeManager();
  const mcp = make({}, manager);
  assert.match((await call(mcp, 'list_browsers', {}, 'text')).text, /^No browsers yet\. start_browser creates one/);
  assert.deepEqual((await call(mcp, 'list_browsers', {}, 'json')).structured, { browsers: [] });
  await call(mcp, 'start_browser', { name: 'a' }, 'json');
  manager.ensure('b');
  Object.assign(manager.state.get('b'), { sandboxUnavailable: true, lastExit: { code: null, signal: 'SIGKILL', at: 0 } });
  const text = (await call(mcp, 'list_browsers', {}, 'text')).text;
  assert.match(text, /^2 browser\(s\):/);
  assert.match(text, /^- a: kind launched, status running, controller agent, cdpEndpoint "http:\/\/127\.0\.0\.1:9333", sandbox true, allowUnsandboxed false$/m);
  assert.match(text, /^- b: .*sandboxUnavailable true \(a human must enable "Allow without sandbox" in the panel\), lastExit code null signal "SIGKILL" at 1970-01-01T00:00:00\.000Z$/m);
  assert.ok(!/^- a: .*(sandboxUnavailable|lastExit|attachError)/m.test(text));
  assert.match(text, /Call browser_info <name> for tabs and the Playwright snippet\.$/);
});

// Invariant: an attached browser's listing line names its address, how it is reached and asksApproval (true, false or
// null), and shows attachError only when there is one; no launched-only part leaks in and no part appears unasked.
test('list_browsers text: attached browsers show address, via, asksApproval and attachError', async () => {
  for (const [via, asks, error] of [['direct', null, null], ['proxy', true, 'nothing is listening'], ['direct', false, null]]) {
    const manager = fakeManager({ attached: via });
    manager.ensure('mine');
    Object.assign(manager.state.get('mine'), { status: 'running', attachError: error });
    manager.state.get('mine').attached.asksApproval = asks;
    const { text } = await call(make({}, manager), 'list_browsers', {}, 'text');
    const line = text.split('\n').find((l) => l.startsWith('- mine: '));
    assert.ok(line.includes(`kind attached, status running`), line);
    assert.ok(line.endsWith(error ? `attached 127.0.0.1:9222 via ${via}, asksApproval ${asks}, attachError "${error}"` : `attached 127.0.0.1:9222 via ${via}, asksApproval ${asks}`), line);
    assert.ok(!/sandboxUnavailable|lastExit/.test(line), line);
  }
});

// Invariant: each conditional part of a listing line is present exactly when its field says so: sandboxUnavailable,
// lastExit and attachError each appear for a browser that has them and for no other.
test('list_browsers text: conditional parts appear only for the browsers that have them', async () => {
  const manager = fakeManager();
  const mcp = make({}, manager);
  for (const n of ['plain', 'refused', 'crashed', 'broken']) manager.ensure(n);
  manager.state.get('refused').sandboxUnavailable = true;
  manager.state.get('crashed').lastExit = { code: 1, signal: null, at: 86_400_000 };
  manager.state.get('broken').attachError = 'refused';
  const lines = Object.fromEntries((await call(mcp, 'list_browsers', {}, 'text')).text.split('\n').filter((l) => l.startsWith('- ')).map((l) => [l.slice(2, l.indexOf(':')), l]));
  assert.ok(!/sandboxUnavailable|lastExit|attachError|attached /.test(lines.plain), lines.plain);
  assert.match(lines.refused, /sandboxUnavailable true \(a human must enable "Allow without sandbox" in the panel\)$/);
  assert.match(lines.crashed, /lastExit code 1 signal null at 1970-01-02T00:00:00\.000Z$/);
  assert.match(lines.broken, /attachError "refused"$/);
  for (const [n, re] of [['refused', /lastExit|attachError/], ['crashed', /sandboxUnavailable|attachError/], ['broken', /sandboxUnavailable|lastExit/]]) assert.ok(!re.test(lines[n]), n);
});

// Invariant: stop_browser reports the kind in json and says in text whether it stopped or only disconnected, so an agent
// never believes it closed the user's own browser.
test('stop_browser: launched is stopped, attached is only disconnected', async () => {
  const launched = make();
  await call(launched, 'start_browser', { name: 'a' }, 'json');
  assert.deepEqual((await call(launched, 'stop_browser', { name: 'a' }, 'json')).structured, { name: 'a', kind: 'launched', status: 'stopped' });
  assert.match((await call(launched, 'stop_browser', { name: 'a' }, 'text')).text, /^Stopped browser 'a'\. Its profile \(logins, cookies\) is kept; start_browser brings it back\.$/);
  const manager = fakeManager({ attached: 'proxy' });
  manager.ensure('mine');
  const mcp = make({}, manager);
  assert.deepEqual((await call(mcp, 'stop_browser', { name: 'mine' }, 'json')).structured, { name: 'mine', kind: 'attached', status: 'stopped' });
  const text = (await call(mcp, 'stop_browser', { name: 'mine' }, 'text')).text;
  assert.match(text, /^Disconnected code-browser from 'mine', the user's own browser: it and its tabs keep running/);
  assert.match(text, /only the user can reconnect it/);
});

// Invariant: start_browser on an attached browser is refused with ATTACHED, details naming the panel path, a message that
// tells the agent to ask the user to Connect it; nothing is started.
test('start_browser on an attached browser is ATTACHED', async () => {
  for (const format of ['text', 'json']) {
    const manager = fakeManager({ attached: 'proxy' });
    const r = await call(make({}, manager), 'start_browser', { name: 'mine' }, format);
    assert.equal(r.code, 'ATTACHED');
    assert.deepEqual(r.details, { name: 'mine', panelPath: '/#plugin/code-browser/?browser=mine' });
    assert.match(r.error, /ask the user/);
    assert.match(r.error, /Connect/);
    assert.equal(manager.list()[0].status, 'stopped');
  }
});

// Invariant: browser_info on a disconnected attached browser is NOT_RUNNING, saying it is the user's own browser, to ask
// them to Connect it, with the panel path in details.
test('browser_info on a stopped attached browser asks for the user to Connect', async () => {
  const manager = fakeManager({ attached: 'direct' });
  manager.ensure('mine');
  const r = await call(make({}, manager), 'browser_info', { name: 'mine' }, 'json');
  assert.equal(r.code, 'NOT_RUNNING');
  assert.match(r.error, /user's own browser/);
  assert.deepEqual(r.details, { name: 'mine', kind: 'attached', panelPath: '/#plugin/code-browser/?browser=mine' });
});

// Invariant: browser_info on an attached browser carries kind and attached, the attached note (the user's tabs, own
// tab, stop only disconnects) and an own-tab snippet, in text and in json.
test('browser_info on an attached browser: data, note and own-tab snippet', async () => {
  const manager = fakeManager({ attached: 'proxy' });
  manager.ensure('mine');
  manager.list()[0].status = 'running';
  const mcp = make({}, manager);
  const r = await call(mcp, 'browser_info', { name: 'mine' }, 'text');
  assert.equal(r.meta.kind, 'attached');
  assert.deepEqual(r.meta.attached, { address: '127.0.0.1:9222', via: 'proxy', asksApproval: false });
  assert.equal(r.meta.sandbox, null);
  assert.match(r.text, /user's own browser/);
  assert.match(r.text, /Work in your own tab/);
  assert.match(r.text, /stop_browser only disconnects/);
  assert.match(r.text, /kind: "attached"/);
  assert.doesNotMatch(r.text, /Allow remote debugging/);
  const d = (await call(mcp, 'browser_info', { name: 'mine' }, 'json')).structured;
  assert.equal(d.kind, 'attached');
  assert.equal(d.notes.length, 1);
  assert.match(d.notes[0], /Work in your own tab/);
  assert.match(d.snippet, /pickPage\(context, \{ activeTargetId: null, kind: "attached" \}\)/);
  assert.ok(!d.rules.some((x) => /viewport/.test(x)), 'the viewport rule is for launched browsers');
});

// Invariant: when Chrome asks approval per connection, the agent is told (text and notes) that the run_code helper asks
// nothing and to warn the user before each snippet script, and the snippet waits for the click.
test('an attached browser that asks approval adds the approval note', async () => {
  const manager = fakeManager({ attached: 'direct', asksApproval: true });
  manager.ensure('mine');
  manager.list()[0].status = 'running';
  const mcp = make({}, manager);
  const r = await call(mcp, 'browser_info', { name: 'mine' }, 'text');
  assert.match(r.text, /Allow remote debugging\?/);
  assert.match(r.text, /run_code helper .* asks nothing/);
  assert.match(r.text, /tell the user before you run one/);
  assert.match(r.text, /connectOverCDP\("ws:\/\/127\.0\.0\.1:9333\/devtools\/browser", \{ timeout: \d+ \}\)/);
  const d = (await call(mcp, 'browser_info', { name: 'mine' }, 'json')).structured;
  assert.equal(d.notes.length, 2);
  assert.match(d.notes[1], /Allow remote debugging\?/);
  assert.match(d.snippet, /\{ timeout: \d+ \}/);
});

// Invariant: the text view never mirrors the json (an agent reading text gets prose, not a serialized object).
test('no tool\'s text equals its json', async () => {
  const mcp = make();
  await call(mcp, 'start_browser', { name: 'a' }, 'json');
  for (const tool of ['list_browsers', 'browser_info', 'stop_browser']) {
    const t = await call(mcp, tool, { name: 'a' }, 'text');
    const j = await call(mcp, tool, { name: 'a' }, 'json');
    assert.notDeepEqual(t, j);
    assert.notEqual(t.text, JSON.stringify(j.structured));
  }
});

// Invariant: `helper` locates everything the run_code helper needs: its own module as a file URL to the real file, the
// relay for this browser on the backend's port, the artifacts route, and the token file and artifacts dir under the
// data dir.
test('helper names the module, relay, artifacts route, token file and artifacts dir', async () => {
  const dataDir = tmpDir();
  const helperInfo = createHelperInfo({ pluginDir, dataDir, port: () => 7470 });
  const manager = fakeManager();
  const mcp = createMcp({ manager, pluginDir, pluginId: 'code-browser', helperInfo });
  const { helper } = (await call(mcp, 'start_browser', { name: 'a' }, 'json')).structured;
  assert.ok(helper.module.startsWith('file:'));
  assert.equal(fileURLToPath(helper.module), fileURLToPath(new URL('../src/runCode/index.js', import.meta.url)));
  assert.ok(fs.existsSync(fileURLToPath(helper.module)));
  assert.equal(helper.relay, 'ws://127.0.0.1:7470/api/relay/a');
  assert.equal(helper.artifacts, 'http://127.0.0.1:7470/api/artifacts');
  assert.equal(helper.tokenFile, relayTokenFile(dataDir));
  assert.ok(helper.artifactsDir.startsWith(`${dataDir}/`));
});

// Invariant: the relay token's value appears in no tool result, json or text: tools name the file only.
test('the relay token value is in no tool result', async () => {
  const dataDir = tmpDir();
  const token = ensureRelayToken(dataDir);
  for (const opts of [{}, { attached: 'direct', asksApproval: true }, { controller: 'human', sandbox: false }]) {
    const manager = fakeManager(opts);
    const mcp = createMcp({ manager, pluginDir, pluginId: 'code-browser', helperInfo: createHelperInfo({ pluginDir, dataDir, port: () => 7470 }) });
    manager.ensure('a');
    if (opts.attached) manager.state.get('a').status = 'running';
    const results = [];
    for (const format of ['json', 'text']) {
      if (!opts.attached) results.push(await call(mcp, 'start_browser', { name: 'a' }, format));
      results.push(await call(mcp, 'browser_info', { name: 'a' }, format), await call(mcp, 'list_browsers', {}, format));
    }
    results.push(await call(mcp, 'stop_browser', { name: 'a' }, 'json'));
    for (const r of results) assert.ok(!JSON.stringify(r).includes(token), JSON.stringify(opts));
  }
});
