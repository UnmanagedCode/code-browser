---
name: drive-browser
description: Drive a shared headless browser with the Code Browser tools (code-browser__start_browser, …) from run_code. Use when you need to open, click through, scrape or screenshot a web page.
---

# Driving a browser with Code Browser

## Flow
1. `start_browser({ name })`. Follow the result's `notes`.
2. Drive it from `run_code`, one program per unit of work, returning a digest (values, text, file paths), never page HTML:
   ```js
   const { browser, page, save } = await (await cc.code_browser.import()).connect({ name: 'default' });
   try {
     await page.goto('https://example.com');
     return { title: await page.title(), shot: await save(await page.screenshot(), 'png') };
   } finally {
     await browser.close();
   }
   ```
   `connect` also returns `context` and `info` (browser_info's data).
   - `save(bytes, ext)` resolves an absolute path: open it with Read. It is how a plan-mode program gets bytes out. Only the newest `ARTIFACTS_KEEP` files in the artifacts dir are kept (`src/limits.js`; a launched browser's downloads land there too): copy any you need to keep.
   - Always close your `browser` (in `finally`): open connections count against the browser's relay limit.
3. Stop only browsers you started.

## Helper or Bash snippet
Prefer the helper. Unlike the result's Bash `snippet`, it:
- works in plan mode;
- asks nothing more of an approval-mode Chrome after the user's Connect; each snippet script raises Chrome's "Allow remote debugging?" dialog for the user;
- enforces the controller lock, which the snippet only reports.

Use the snippet only when `run_code` is not among your tools or the work outlasts run_code's `timeoutMs` ceiling. Never switch to the snippet or the raw `cdpEndpoint` to get past a refusal the helper gave.

## When a person has control
- While `controller` is `"human"`, `connect` throws `BROWSER_CONTROLLED`. If a person takes control mid-program, your connection is dropped and pending calls reject with `BROWSER_CONTROLLED` in the message. Don't retry in a loop: tell the user what you are waiting for, then run a new program that re-reads the page (they may have navigated).
- For a sign-in, give the user `panelPath` and ask them to take control, sign in and hand back. Never ask for credentials in chat. The login stays with that browser name.

## `SANDBOX_UNAVAILABLE`
Don't retry, don't try another browser name, don't launch a Chromium yourself, and don't touch code-browser's data dir or HTTP routes: each bypasses a gate that exists for the person's consent.

## Other refusals
| Code | Do |
|---|---|
| `NOT_FOUND` | No browser by that name: check `list_browsers`, or `start_browser` creates one. |
| `NOT_RUNNING`, or `CDP_CLOSED` in a dropped program's error | The browser stopped or crashed: call `start_browser` again (its refusal says when only the user can reconnect it), then run a new program. |
| `RELAY_FULL` | The browser already has `RELAY_MAX_CLIENTS` helper connections (`src/limits.js`): close yours and don't run programs on one browser in parallel. Retry once later, then tell the user. |
| `RELAY_SLOW` in a dropped program's error | The program stopped reading: don't block the event loop while connected. |
| `UNAUTHORIZED` | The helper's relay token was refused: tell the user. Don't read the token file or connect with it yourself. |
| a CDP call answered "… is not allowed through code-browser's relay" | Refused by design (`FORBIDDEN` in `src/relayRoutes.js`): closing or crashing the shared browser, or opening a CDP channel the relay cannot see. Don't attempt it another way. |
| `MODULE_UNKNOWN` | Call `import()` with no argument. If cc still refuses, the helper is not loaded: use the snippet and tell the user. |
