// The Playwright script `browser_info` hands the agent. It resolves playwright-core from this plugin's own
// node_modules, so the agent's project needs no install.
export function buildSnippet({ pluginDir, cdpEndpoint, activeTargetId }) {
  const pickActive = activeTargetId
    ? `for (const p of context.pages()) {                      // pick the tab the human is looking at
  const s = await context.newCDPSession(p);
  const { targetInfo } = await s.send('Target.getTargetInfo'); await s.detach();
  if (targetInfo.targetId === ${JSON.stringify(activeTargetId)}) { page = p; break; }
}
`
    : '';
  return `import { createRequire } from 'node:module';
const { chromium } = createRequire(${JSON.stringify(`${pluginDir}/package.json`)})('playwright-core');
const browser = await chromium.connectOverCDP(${JSON.stringify(cdpEndpoint)});
const context = browser.contexts()[0];
let page = context.pages()[0];
${pickActive}// … your steps …
await browser.close(); // disconnects only — the browser and its tabs keep running
`;
}
