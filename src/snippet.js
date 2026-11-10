import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APPROVAL_TIMEOUT_MS } from './limits.js';

// The Playwright script `browser_info` hands the agent for Bash. It resolves playwright-core from this plugin's own
// node_modules, so the agent's project needs no install, and it picks its page with the run_code helper's own rule
// (src/runCode/pickPage.js, imported by URL). It connects to the raw CDP endpoint: a new connection per script.
export function buildSnippet({ pluginDir, cdpEndpoint, activeTargetId, attached = false, asksApproval = false }) {
  const pickPageUrl = pathToFileURL(path.join(pluginDir, 'src', 'runCode', 'pickPage.js')).href;
  // Chrome holds the connection until the person answers its "Allow remote debugging?" dialog.
  const options = asksApproval ? `, { timeout: ${APPROVAL_TIMEOUT_MS} }` : '';
  const pick = `{ activeTargetId: ${JSON.stringify(activeTargetId ?? null)}, kind: ${JSON.stringify(attached ? 'attached' : 'launched')} }`;
  return `import { createRequire } from 'node:module';
import { pickPage } from ${JSON.stringify(pickPageUrl)};
const { chromium } = createRequire(${JSON.stringify(`${pluginDir}/package.json`)})('playwright-core');
const browser = await chromium.connectOverCDP(${JSON.stringify(cdpEndpoint)}${options});
const context = browser.contexts()[0];
let page = await pickPage(context, ${pick}); // the tab the human is looking at${attached ? ', else your own new tab' : ''}
// … your steps …
await browser.close(); // disconnects only — the browser and its tabs keep running
`;
}
