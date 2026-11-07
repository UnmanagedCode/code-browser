import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcp } from '../src/mcp.js';
import { fakeManager } from './fakes/fakeMcpManager.mjs';

// Golden texts: the browser_info text exactly as the pre-typed src/mcp.js produced it for the same fake state, captured
// once from that implementation and written out as literals (not derived from the current renderer).
const GOLDEN = {
  plain: "Panel: /#plugin/code-browser/?browser=a — it is relative to the address the user opens cc at. Give it to the user as-is, or as a markdown link with that path as the target. Do not add a host.\n\nRules:\n- Use `browser.contexts()[0]`, never `newContext()`: a new context is incognito and not shared with the panel.\n- `browser.close()` only disconnects; the browser keeps running.\n- The page viewport is 1280 px wide; its height follows the shape of the person's panel and can change between scripts. Read innerHeight instead of assuming it, and do not set your own viewport (page.setViewportSize): it conflicts with the panel's.\n\nSave this as an .mjs file and run it with node via Bash:\n```js\nimport { createRequire } from 'node:module';\nconst { chromium } = createRequire(\"/plug/package.json\")('playwright-core');\nconst browser = await chromium.connectOverCDP(\"http://127.0.0.1:9333\");\nconst context = browser.contexts()[0];\nlet page = context.pages()[0];\nfor (const p of context.pages()) {                      // pick the tab the human is looking at\n  const s = await context.newCDPSession(p);\n  const { targetInfo } = await s.send('Target.getTargetInfo'); await s.detach();\n  if (targetInfo.targetId === \"T1\") { page = p; break; }\n}\n// … your steps …\nawait browser.close(); // disconnects only — the browser and its tabs keep running\n```",
  launchedHumanUnsandboxed: "A human currently has control of this browser. Do not drive it: do not click, type or navigate. Call browser_info again later; it shows controller \"agent\" once control is back.\n\nWARNING: this browser runs without Chromium's sandbox (the host has no usable one), so a compromised page could run code as the host user. Do not browse untrusted pages in it, especially with logged-in profiles.\n\nPanel: /#plugin/code-browser/?browser=a — it is relative to the address the user opens cc at. Give it to the user as-is, or as a markdown link with that path as the target. Do not add a host.\n\nRules:\n- Use `browser.contexts()[0]`, never `newContext()`: a new context is incognito and not shared with the panel.\n- `browser.close()` only disconnects; the browser keeps running.\n- The page viewport is 1280 px wide; its height follows the shape of the person's panel and can change between scripts. Read innerHeight instead of assuming it, and do not set your own viewport (page.setViewportSize): it conflicts with the panel's.\n\nSave this as an .mjs file and run it with node via Bash:\n```js\nimport { createRequire } from 'node:module';\nconst { chromium } = createRequire(\"/plug/package.json\")('playwright-core');\nconst browser = await chromium.connectOverCDP(\"http://127.0.0.1:9333\");\nconst context = browser.contexts()[0];\nlet page = context.pages()[0];\nfor (const p of context.pages()) {                      // pick the tab the human is looking at\n  const s = await context.newCDPSession(p);\n  const { targetInfo } = await s.send('Target.getTargetInfo'); await s.detach();\n  if (targetInfo.targetId === \"T1\") { page = p; break; }\n}\n// … your steps …\nawait browser.close(); // disconnects only — the browser and its tabs keep running\n```",
  attachedApprovalHuman: "A human currently has control of this browser. Do not drive it: do not click, type or navigate. Call browser_info again later; it shows controller \"agent\" once control is back.\n\nThis is the user's own browser, which they attached in the panel: its other tabs and logged-in sessions are theirs. Work in your own tab and do not close tabs you did not open. `sandbox` is null because code-browser did not launch it, so nothing is known about its sandbox or profile. stop_browser only disconnects, and only the user can reconnect it. A person may be using its window right now.\n\nChrome asks the user \"Allow remote debugging?\" for every connection to this browser, and each script you run opens a new one. Tell the user before you run a script; it waits until they click Allow and fails with 403 if they cancel. Do the work in as few scripts as possible.\n\nPanel: /#plugin/code-browser/?browser=mine — it is relative to the address the user opens cc at. Give it to the user as-is, or as a markdown link with that path as the target. Do not add a host.\n\nRules:\n- Use `browser.contexts()[0]`, never `newContext()`: a new context is incognito and not shared with the panel.\n- `browser.close()` only disconnects; the browser keeps running.\n\nSave this as an .mjs file and run it with node via Bash:\n```js\nimport { createRequire } from 'node:module';\nconst { chromium } = createRequire(\"/plug/package.json\")('playwright-core');\nconst browser = await chromium.connectOverCDP(\"ws://127.0.0.1:9333/devtools/browser\", { timeout: 120000 });\nconst context = browser.contexts()[0];\nlet page = await context.newPage(); // your own tab: the other tabs are the user's\n// … your steps …\nawait browser.close(); // disconnects only — the browser and its tabs keep running\n```",
};

async function infoText(opts, name) {
  const manager = fakeManager(opts);
  manager.ensure(name);
  if (opts.attached) manager.state.get(name).status = 'running';
  else await manager.start(name);
  const mcp = createMcp({ manager, pluginDir: '/plug', pluginId: 'code-browser' });
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
