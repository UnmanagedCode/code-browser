import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { CodedError } from '../errors.js';
import { CDP_TIMEOUT_MS, DEFAULT_BROWSER_NAME } from '../limits.js';
import { HUMAN_NOTE } from '../notes.js';
import { pickPage } from './pickPage.js';
import { createSave } from './save.js';

// The codes a refused relay upgrade names on its own line of the text Playwright throws (cdpRelay.js `refuse`).
const RELAY_REFUSAL = /^(UNAUTHORIZED|INVALID_NAME|NOT_FOUND|NOT_RUNNING|BROWSER_CONTROLLED|RELAY_FULL): (.*)$/m;

// `connect({name, timeout})` → {browser, context, page, info, save}: a Playwright browser connected through
// code-browser's CDP relay (the connection the user already allowed for an attached Chrome). `info` is browser_info's
// data; `browser.close()` only disconnects. `cc` is the program's cc object; only `cc.code_browser.browser_info` is used.
export function createConnect(cc) {
  return async function connect({ name = DEFAULT_BROWSER_NAME, timeout = CDP_TIMEOUT_MS } = {}) {
    const info = await cc.code_browser.browser_info({ name });
    if (info.controller === 'human') throw new CodedError('BROWSER_CONTROLLED', HUMAN_NOTE);
    const { helper } = info;
    const token = (await fs.readFile(helper.tokenFile, 'utf8')).trim();
    let browser;
    try {
      // artifactsDir: without it Playwright creates a temp dir, which cc's plan mode refuses.
      browser = await chromium.connectOverCDP(helper.relay, {
        headers: { authorization: `Bearer ${token}` },
        artifactsDir: helper.artifactsDir,
        noDefaults: info.kind === 'attached',
        timeout,
      });
    } catch (err) {
      const m = RELAY_REFUSAL.exec(err.message);
      if (m) throw new CodedError(m[1], m[2]);
      throw err;
    }
    const context = browser.contexts()[0];
    const page = await pickPage(context, info);
    return { browser, context, page, info, save: createSave({ url: helper.artifacts, token }) };
  };
}
