import test from 'node:test';
import assert from 'node:assert/strict';
import { CodedError } from '../src/errors.js';
import { createApp } from '../src/app.js';
import { TEXT_VIEWS } from '../src/mcpViews.js';
import { JSON_HEADERS, idleInstaller, listen, request, tmpDir } from './helpers.mjs';
import { createMcp } from '../src/mcp.js';
import { buildSnippet } from '../src/snippet.js';
import { call } from './_mcpCall.mjs';
import { fakeManager } from './fakes/fakeMcpManager.mjs';

const make = (opts, manager = fakeManager(opts)) => createMcp({ manager, pluginDir: '/plug', pluginId: 'code-browser' });
const FORMATS = ['text', 'json'];

// ---- refusals: code, shape and details, identical in both formats ----

// Invariant: a format other than text/json (null and non-strings included) is FORMAT_UNKNOWN, never silently text.
test('FORMAT_UNKNOWN for any other format', async () => {
  const deep = JSON.parse('['.repeat(9000) + ']'.repeat(9000));
  for (const format of ['xml', null, 42, '', deep, { a: { b: 1 } }, [1, [2]], 10n, Symbol('s')]) {
    const r = await make().handle({ tool: 'list_browsers', format });
    assert.equal(r.code, 'FORMAT_UNKNOWN', typeof format);
    assert.ok(r.error.length < 200);
    assert.deepEqual(Object.keys(r).sort(), ['code', 'error']);
  }
  assert.ok((await make().handle({ tool: 'list_browsers', format: 'x'.repeat(5000) })).error.length < 200, 'a huge value is not echoed whole');
});

// Invariant: tool lookup is an own-property check: prototype names, a missing tool and a non-string tool are TOOL_UNKNOWN.
test('TOOL_UNKNOWN for unknown, prototype, missing and non-string tools', async () => {
  const mcp = make();
  const deep = JSON.parse('['.repeat(9000) + ']'.repeat(9000));
  for (const tool of ['nope', 'toString', 'constructor', '__proto__', 'hasOwnProperty', undefined, 7, null, {}, deep, { a: { b: 1 } }, [1, [2]], 10n]) {
    for (const format of FORMATS) {
      const r = await call(mcp, tool, {}, format);
      assert.equal(r.code, 'TOOL_UNKNOWN', typeof tool);
      assert.ok(r.error.length < 200);
    }
  }
  assert.equal((await mcp.handle({})).code, 'TOOL_UNKNOWN');
  assert.equal((await mcp.handle(undefined)).code, 'TOOL_UNKNOWN');
});

// Invariant: `arguments` that is not an object is BAD_REQUEST before any handler runs.
test('BAD_REQUEST for non-object arguments', async () => {
  for (const args of ['x', [1], 5, true]) {
    for (const format of FORMATS) assert.equal((await call(make(), 'list_browsers', args, format)).code, 'BAD_REQUEST');
  }
});

// Invariant: invalid, unknown and stopped-launched names are refused with their stable codes and details.
test('INVALID_NAME, NOT_FOUND and NOT_RUNNING (launched)', async () => {
  for (const format of FORMATS) {
    const mcp = make();
    assert.equal((await call(mcp, 'start_browser', { name: '../x' }, format)).code, 'INVALID_NAME');
    assert.equal((await call(mcp, 'start_browser', { name: 5 }, format)).code, 'INVALID_NAME');
    assert.equal((await call(mcp, 'stop_browser', { name: 'ghost' }, format)).code, 'NOT_FOUND');
    assert.equal((await call(mcp, 'browser_info', { name: 'ghost' }, format)).code, 'NOT_FOUND');
    await call(mcp, 'start_browser', { name: 'a' }, 'json');
    await call(mcp, 'stop_browser', { name: 'a' }, 'json');
    const r = await call(mcp, 'browser_info', { name: 'a' }, format);
    assert.equal(r.code, 'NOT_RUNNING');
    assert.deepEqual(r.details, { name: 'a', kind: 'launched' });
  }
});

// Invariant: NOT_RUNNING for an attached browser carries the panel path in details and tells the agent to ask the user to Connect.
test('NOT_RUNNING (attached) names details.panelPath and says to ask the user to Connect', async () => {
  const manager = fakeManager({ attached: 'direct' });
  manager.ensure('mine');
  const r = await call(make({}, manager), 'browser_info', { name: 'mine' }, 'text');
  assert.equal(r.code, 'NOT_RUNNING');
  assert.deepEqual(r.details, { name: 'mine', kind: 'attached', panelPath: '/#plugin/code-browser/?browser=mine' });
  assert.match(r.error, /ask the user to press Connect/);
  assert.ok(!r.error.includes('/#plugin'));
});

// Invariant: SANDBOX_UNAVAILABLE and ATTACHED keep the panel path out of the message and in details {name, panelPath}.
test('SANDBOX_UNAVAILABLE and ATTACHED details are {name, panelPath}', async () => {
  const sandbox = await call(make({ refuse: true }), 'start_browser', { name: 'a' }, 'json');
  const attached = await call(make({ attached: 'proxy' }), 'start_browser', { name: 'a' }, 'json');
  for (const [r, code] of [[sandbox, 'SANDBOX_UNAVAILABLE'], [attached, 'ATTACHED']]) {
    assert.equal(r.code, code);
    assert.deepEqual(r.details, { name: 'a', panelPath: '/#plugin/code-browser/?browser=a' });
    assert.ok(!r.error.includes('/#plugin'));
    assert.match(r.error, /ask the user/);
  }
});

// Invariant: the diagnostics a manager attaches to a refusal (tried paths, install command, path, log tail) reach the
// caller untouched in details.
test('CHROMIUM_NOT_FOUND and LAUNCH_FAILED details pass through', async () => {
  const cases = [
    new CodedError('CHROMIUM_NOT_FOUND', 'No Chromium found', { tried: ['/a', '/b'], install: 'npm run install-browser' }),
    new CodedError('CHROMIUM_NOT_FOUND', 'CODE_BROWSER_CHROMIUM points at a missing file', { path: '/nope' }),
    new CodedError('LAUNCH_FAILED', 'Chromium exited during launch', { logTail: 'l1\nl2' }),
    new CodedError('LAUNCH_FAILED', 'could not connect to CDP on port 1: refused'),
  ];
  for (const err of cases) {
    for (const format of FORMATS) {
      const manager = fakeManager();
      manager.start = async () => { throw err; };
      const r = await call(make({}, manager), 'start_browser', { name: 'a' }, format);
      assert.equal(r.code, err.code);
      assert.equal(r.error, err.message);
      assert.deepEqual(r.details, err.details);
      assert.equal(Object.hasOwn(r, 'details'), Boolean(err.details));
    }
  }
});

// Invariant: a CodedError the manager raises (EXISTS, CDP_*) keeps its own code.
test('manager codes pass through', async () => {
  for (const code of ['EXISTS', 'CDP_TIMEOUT', 'CDP_ERROR', 'CDP_CLOSED']) {
    const manager = fakeManager();
    manager.start = async () => { throw new CodedError(code, 'boom'); };
    assert.equal((await call(make({}, manager), 'start_browser', {}, 'json')).code, code);
  }
});

// Invariant: an unexpected error is INTERNAL (never the raw fs code), names the tool and the cause, and carries no
// details and no stack.
test('INTERNAL: tool name and cause in the message, no raw code, no details, no stack', async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    for (const format of FORMATS) {
      const manager = fakeManager();
      manager.list = () => { throw Object.assign(new Error('disk gone'), { code: 'EACCES' }); };
      const r = await call(make({}, manager), 'list_browsers', {}, format);
      assert.equal(r.code, 'INTERNAL');
      assert.match(r.error, /list_browsers/);
      assert.match(r.error, /disk gone/);
      assert.equal(Object.hasOwn(r, 'details'), false);
      assert.doesNotMatch(JSON.stringify(r), /\bat .*\(|\.js:\d+/);
    }
  } finally {
    console.error = origError;
  }
});

// ---- removed caps: the json is the complete data ----

// Invariant: no tab and no browser is dropped in json, and text meta keeps every tab: a cap returning fails here.
test('60 tabs and 40 browsers are all returned', async () => {
  const tabs = Array.from({ length: 60 }, (_, i) => ({ targetId: `T${i}`, url: `https://x.test/${i}`, title: `t${i}`, active: i === 0 }));
  const manager = fakeManager({ tabs });
  const mcp = make({}, manager);
  for (let i = 0; i < 40; i += 1) await call(mcp, 'start_browser', { name: `b${i}` }, 'json');
  const { structured } = await call(mcp, 'browser_info', { name: 'b0' }, 'json');
  assert.deepEqual(structured.tabs, tabs);
  assert.deepEqual((await call(mcp, 'list_browsers', {}, 'json')).structured.browsers, manager.list());
  assert.equal((await call(mcp, 'list_browsers', {}, 'json')).structured.browsers.length, 40);
  assert.deepEqual((await call(mcp, 'browser_info', { name: 'b0' }, 'text')).meta.tabs, tabs);
  const text = (await call(mcp, 'list_browsers', {}, 'text')).text;
  assert.equal(text.split('\n').filter((l) => l.startsWith('- ')).length, 40);
});

// Invariant: the json snippet is the whole buildSnippet output, and json carries every field manager.info() has
// (the projection never drops one), plus panelPath, notes, rules and snippet.
test('json snippet is whole and json keys cover manager.info()', async () => {
  const manager = fakeManager();
  const mcp = make({}, manager);
  const { structured } = await call(mcp, 'start_browser', { name: 'a' }, 'json');
  assert.equal(structured.snippet, buildSnippet({ pluginDir: '/plug', cdpEndpoint: 'http://127.0.0.1:9333', activeTargetId: 'T1' }));
  const keys = Object.keys(structured);
  for (const k of [...Object.keys(await manager.info('a')), 'panelPath', 'notes', 'rules', 'snippet']) assert.ok(keys.includes(k), k);
});

// Invariant: notes are exactly the warnings whose state applies now: human + unsandboxed gives two; attached +
// approval + human gives three (the attached note, approval note and the human note).
test('notes list every applicable warning', async () => {
  const a = make({ controller: 'human', sandbox: false });
  await call(a, 'start_browser', { name: 'a' }, 'json');
  assert.equal((await call(a, 'browser_info', { name: 'a' }, 'json')).structured.notes.length, 2);
  const manager = fakeManager({ attached: 'direct', asksApproval: true, controller: 'human' });
  manager.ensure('mine');
  manager.state.get('mine').status = 'running';
  const b = await call(make({}, manager), 'browser_info', { name: 'mine' }, 'json');
  assert.equal(b.structured.notes.length, 3);
  const text = (await call(make({}, manager), 'browser_info', { name: 'mine' }, 'text')).text;
  for (const note of b.structured.notes) assert.ok(text.includes(note));
});

// Invariant: a deeply nested `format` or `tool` that fits the body limit reaches cc as HTTP 200 with the refusal, never a 500.
test('through a real server, a deeply nested format or tool is HTTP 200 with a refusal', async () => {
  const server = createApp({ manager: fakeManager(), mcp: make(), installer: idleInstaller, distDir: tmpDir() });
  const port = await listen(server);
  try {
    const nested = '['.repeat(9000) + ']'.repeat(9000);
    for (const [body, code] of [[`{"tool":"list_browsers","format":${nested}}`, 'FORMAT_UNKNOWN'], [`{"tool":${nested},"format":"json"}`, 'TOOL_UNKNOWN']]) {
      assert.ok(body.length < 64 * 1024);
      const r = await request(port, { method: 'POST', path: '/api/mcp', headers: JSON_HEADERS, body });
      assert.equal(r.status, 200);
      assert.equal(r.json.code, code);
      assert.equal(typeof r.json.error, 'string');
    }
  } finally {
    server.close();
  }
});

// Invariant: a thrown value whose `message` getter throws still yields an INTERNAL refusal (building the message is exception-safe).
test('INTERNAL survives a thrown object with a hostile message', async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    const hostile = Object.defineProperty({}, 'message', { get() { throw new Error('x'); } });
    for (const thrown of [hostile, Object.create(null), { toString() { throw new Error('y'); } }]) {
      const manager = fakeManager();
      manager.list = () => { throw thrown; };
      const r = await call(make({}, manager), 'list_browsers', {}, 'json');
      assert.equal(r.code, 'INTERNAL');
      assert.match(r.error, /list_browsers failed unexpectedly/);
    }
  } finally {
    console.error = origError;
  }
});

// Invariant: every served tool has a text view and no view is orphaned, so the text and json formats cover the same tools.
test('handler tools and text views have the same key set', () => {
  assert.deepEqual(make().toolNames.slice().sort(), Object.keys(TEXT_VIEWS).sort());
});

// Invariant: a thrown value whose message is not a string (a Symbol, or an object whose toString throws), or that is a
// revoked Proxy, still yields an INTERNAL refusal: coercing the message and classifying the error never throw out of handle.
test('INTERNAL survives a non-string message and a revoked Proxy', async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const thrown of [{ message: Symbol('m') }, { message: { toString() { throw new Error('x'); } } }, revoked.proxy]) {
      const manager = fakeManager();
      manager.list = () => { throw thrown; };
      const r = await make({}, manager).handle({ tool: 'list_browsers', format: 'json' });
      assert.equal(r.code, 'INTERNAL');
      assert.match(r.error, /list_browsers failed unexpectedly/);
    }
  } finally {
    console.error = origError;
  }
});

// Invariant: a revoked Proxy as `format` or `tool` is a FORMAT_UNKNOWN / TOOL_UNKNOWN refusal, never a throw.
test('a revoked Proxy as format or tool is refused', async () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const mcp = make();
  assert.equal((await mcp.handle({ tool: 'list_browsers', format: revoked.proxy })).code, 'FORMAT_UNKNOWN');
  assert.equal((await mcp.handle({ tool: revoked.proxy, format: 'json' })).code, 'TOOL_UNKNOWN');
});
