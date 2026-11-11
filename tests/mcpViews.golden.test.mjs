import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcp } from '../src/mcp.js';
import { fakeManager, testHelperInfo } from './fakes/fakeMcpManager.mjs';

// Golden texts: the browser_info text for a fixed fake state, written out as literals (not derived from the current
// renderer), so any change to the prose an agent reads is a deliberate edit here.
const GOLDEN = {
  plain: "Panel: /#plugin/code-browser/?browser=a — it is relative to the address the user opens cc at. Give it to the user as-is, or as a markdown link with that path as the target. Do not add a host.\n\nRules:\n- Use `browser.contexts()[0]`, never `newContext()`: a new context is incognito and not shared with the panel.\n- `browser.close()` only disconnects; the browser keeps running.\n- The page viewport is 1280 px wide; its height follows the shape of the person's panel and can change between scripts. Read innerHeight instead of assuming it, and do not set your own viewport (page.setViewportSize): it conflicts with the panel's.\n\nIn run_code: const { page } = await cc.code_browser.connect({ name: \"a\" });\n\nFrom Bash, save this as an .mjs file and run it with node:\n```js\nimport { createRequire } from 'node:module';\nimport { pickPage } from \"file:///plug/src/runCode/pickPage.js\";\nconst { chromium } = createRequire(\"/plug/package.json\")('playwright-core');\nconst browser = await chromium.connectOverCDP(\"http://127.0.0.1:9333\");\nconst context = browser.contexts()[0];\nlet page = await pickPage(context, { activeTargetId: \"T1\", kind: \"launched\" }); // the tab the human is looking at\n// … your steps …\nawait browser.close(); // disconnects only — the browser and its tabs keep running\n```",
  launchedHumanUnsandboxed: "A human currently has control of this browser. Do not drive it: do not click, type or navigate. The run_code helper is refused while a human has control. Call browser_info again later; it shows controller \"agent\" once control is back.\n\nWARNING: this browser runs without Chromium's sandbox (the host has no usable one), so a compromised page could run code as the host user. Do not browse untrusted pages in it, especially with logged-in profiles.\n\nPanel: /#plugin/code-browser/?browser=a — it is relative to the address the user opens cc at. Give it to the user as-is, or as a markdown link with that path as the target. Do not add a host.\n\nRules:\n- Use `browser.contexts()[0]`, never `newContext()`: a new context is incognito and not shared with the panel.\n- `browser.close()` only disconnects; the browser keeps running.\n- The page viewport is 1280 px wide; its height follows the shape of the person's panel and can change between scripts. Read innerHeight instead of assuming it, and do not set your own viewport (page.setViewportSize): it conflicts with the panel's.\n\nIn run_code: const { page } = await cc.code_browser.connect({ name: \"a\" });\n\nFrom Bash, save this as an .mjs file and run it with node:\n```js\nimport { createRequire } from 'node:module';\nimport { pickPage } from \"file:///plug/src/runCode/pickPage.js\";\nconst { chromium } = createRequire(\"/plug/package.json\")('playwright-core');\nconst browser = await chromium.connectOverCDP(\"http://127.0.0.1:9333\");\nconst context = browser.contexts()[0];\nlet page = await pickPage(context, { activeTargetId: \"T1\", kind: \"launched\" }); // the tab the human is looking at\n// … your steps …\nawait browser.close(); // disconnects only — the browser and its tabs keep running\n```",
  attachedApprovalHuman: "A human currently has control of this browser. Do not drive it: do not click, type or navigate. The run_code helper is refused while a human has control. Call browser_info again later; it shows controller \"agent\" once control is back.\n\nThis is the user's own browser, which they attached in the panel: its other tabs and logged-in sessions are theirs. Work in your own tab and do not close tabs you did not open. `sandbox` is null because code-browser did not launch it, so nothing is known about its sandbox or profile. stop_browser only disconnects, and only the user can reconnect it. A person may be using its window right now.\n\nChrome asks the user \"Allow remote debugging?\" for every new connection to this browser. The run_code helper uses code-browser's connection, which the user already allowed, and asks nothing. Each Bash snippet script opens a new connection: tell the user before you run one; it waits until they click Allow and fails with 403 if they cancel. Do the work in as few snippet scripts as possible.\n\nPanel: /#plugin/code-browser/?browser=mine — it is relative to the address the user opens cc at. Give it to the user as-is, or as a markdown link with that path as the target. Do not add a host.\n\nRules:\n- Use `browser.contexts()[0]`, never `newContext()`: a new context is incognito and not shared with the panel.\n- `browser.close()` only disconnects; the browser keeps running.\n\nIn run_code: const { page } = await cc.code_browser.connect({ name: \"mine\" });\n\nFrom Bash, save this as an .mjs file and run it with node:\n```js\nimport { createRequire } from 'node:module';\nimport { pickPage } from \"file:///plug/src/runCode/pickPage.js\";\nconst { chromium } = createRequire(\"/plug/package.json\")('playwright-core');\nconst browser = await chromium.connectOverCDP(\"ws://127.0.0.1:9333/devtools/browser\", { timeout: 120000 });\nconst context = browser.contexts()[0];\nlet page = await pickPage(context, { activeTargetId: null, kind: \"attached\" }); // the tab the human is looking at, else your own new tab\n// … your steps …\nawait browser.close(); // disconnects only — the browser and its tabs keep running\n```",
};

async function infoText(opts, name) {
  const manager = fakeManager(opts);
  manager.ensure(name);
  if (opts.attached) manager.state.get(name).status = 'running';
  else await manager.start(name);
  const mcp = createMcp({ manager, pluginDir: '/plug', pluginId: 'code-browser', helperInfo: testHelperInfo });
  return (await mcp.handle({ tool: 'browser_info', arguments: { name }, format: 'text' })).text;
}

// Invariant: a plain launched browser's browser_info text is, character for character, the established prose.
test('golden browser_info text: plain launched browser', async () => {
  assert.equal(await infoText({}, 'a'), GOLDEN.plain);
});

// Invariant: with the human and unsandboxed notes together, their order, the blank line after each note, the Panel line,
// the rules, the "Save this as" line and the fenced snippet are exactly the established prose.
test('golden browser_info text: launched, human and unsandboxed', async () => {
  assert.equal(await infoText({ controller: 'human', sandbox: false }, 'a'), GOLDEN.launchedHumanUnsandboxed);
});

// Invariant: with the attached, approval and human notes together, the note order and the attached snippet are exactly
// the established prose (human first, then attached, then approval).
test('golden browser_info text: attached, approval and human', async () => {
  assert.equal(await infoText({ attached: 'direct', asksApproval: true, controller: 'human' }, 'mine'), GOLDEN.attachedApprovalHuman);
});
