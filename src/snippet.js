import { APPROVAL_TIMEOUT_MS } from './limits.js';

// The Playwright script `browser_info` hands the agent. It resolves playwright-core from this plugin's own
// node_modules, so the agent's project needs no install. In an attached browser (a person's own) with no
// active tab, the script opens a tab of its own rather than taking one of theirs.
export function buildSnippet({ pluginDir, cdpEndpoint, activeTargetId, attached = false, asksApproval = false }) {
  const pickActive = activeTargetId
    ? `for (const p of context.pages()) {                      // pick the tab the human is looking at
  const s = await context.newCDPSession(p);
  const { targetInfo } = await s.send('Target.getTargetInfo'); await s.detach();
  if (targetInfo.targetId === ${JSON.stringify(activeTargetId)}) { page = p; break; }
}
`
    : '';
  const firstPage = attached && !activeTargetId
    ? "let page = await context.newPage(); // your own tab: the other tabs are the user's"
    : 'let page = context.pages()[0];';
  // Chrome holds the connection until the person answers its "Allow remote debugging?" dialog.
  const options = asksApproval ? `, { timeout: ${APPROVAL_TIMEOUT_MS} }` : '';
  return `import { createRequire } from 'node:module';
const { chromium } = createRequire(${JSON.stringify(`${pluginDir}/package.json`)})('playwright-core');
const browser = await chromium.connectOverCDP(${JSON.stringify(cdpEndpoint)}${options});
const context = browser.contexts()[0];
${firstPage}
${pickActive}// … your steps …
await browser.close(); // disconnects only — the browser and its tabs keep running
`;
}
