# Architecture

> See also: [README](../README.md) · [features](features.md) · [protocol](protocol.md)

## Stack

- **Backend:** plain ESM JavaScript, `node server.js`, `node:http`. Runtime dependencies: `ws` (the panel socket and the backend's CDP client) and `playwright-core` (Chromium lookup, and the package the agent snippet resolves). The backend never drives pages with Playwright: its own CDP client avoids Playwright's dialog auto-dismissal and extra state.
- **Panel:** React, TypeScript, Vite (`base: './'`), plain CSS on cc's theme tokens (no inline styles, so the CSP needs no `'unsafe-inline'`). Built into the gitignored `frontend/dist` by `prepare`.
- **Plugin contract:** `conductor.plugin.json`. cc starts the backend lazily, passing `PORT` and `PROJECTS_ROOT`; MCP calls arrive as plain `POST api/mcp` ([protocol.md](protocol.md#mcp-wire-format)).
- **No install scripts** in the runtime dependency tree (`tests/deps.test.mjs`). `package-lock.json` is gitignored.

## Modules

```
server.js                thin wiring: config → manager → mcp → app (+ gateway) → listen, graceful shutdown
src/config.js            PORT, data dir ($PROJECTS_ROOT/.code-browser), plugin dir, plugin id
src/limits.js            every tunable constant and NAME_RE
src/errors.js            CodedError and the code → HTTP status map
src/requestGuard.js      Origin↔Host check
src/http.js              CSP/security headers, JSON body reader, static allowlist
src/routes.js            REST table (GET handlers read-only)
src/app.js               HTTP server: guard order, dispatch, clientError, upgrade hook
src/mcp.js               the tools; always answers {result}|{error}|{text,meta}
src/snippet.js           the Playwright snippet; src/panelLink.js the shell link
src/browserManager.js    profiles, launch/stop/delete, run state, one entry per running browser
src/chromium/{locate,args,keeper}.js
src/runState.js          run/<name>.json, pid checks, reap
src/cdp.js               CDP client over ws
src/browserSession.js    per running browser: tabs, dialogs, nav state, input, controller, screencast
src/{tabs,controller,screencast,input,frame}.js   pure or near-pure parts of the session
src/viewerGateway.js     panel WebSocket: permissions and fan-out
frontend/src             main/App/api/socket/route/frame, components/, input/
```

One responsibility each: `browserManager` owns processes and files, `browserSession` owns live state, `viewerGateway` owns the human-facing protocol and its permission checks. The REST routes, the MCP tools and the gateway call the same manager and session methods.

## On-disk layout (`$PROJECTS_ROOT/.code-browser/`)

| Path | Holds |
|---|---|
| `profiles/<name>/` | the persistent Chromium profile |
| `run/<name>.json` | `{keeperPid, chromiumPid, startedAt}` while running |
| `logs/<name>.log` | Chromium output, truncated on each launch |
| `trash/<name>-<ts>/` | a deleted profile, removed asynchronously |

Permissions (`src/fsPrivate.js`): the data dir, its top-level dirs (`profiles`, `run`, `logs`, `trash`), each profile root and each trash entry are `0700`; the plugin's run files and logs are `0600`. Existing paths are tightened by chmod at boot, create and start. Files nested inside a profile are Chrome's own; the `0700` profile root shields them. The log holds visited URLs and a profile's `DevToolsActivePort` exposes CDP.

`NAME_RE` is the single name check for REST, MCP and the socket (the panel imports it from `src/limits.js`). A new profile is seeded with `session.restore_on_startup = 1` so session cookies (and the previous tabs) survive a stop; an existing profile's `Preferences` is never rewritten.

## Browser lifecycle

**Start** (`browserManager.start`, serialised per name; a no-op when running):

1. `reap`: kill leftovers recorded in the run file. A pid is killed only if its `/proc/<pid>/cmdline` argv still carries this profile's `--user-data-dir=<dir>` as a whole token (and, for the keeper, the keeper script as a whole token), so a recycled pid, or profile `ab` when reaping `a`, is left alone.
2. Remove stale `Singleton*` and `DevToolsActivePort` from the profile.
3. Spawn the **keeper** (`src/chromium/keeper.js`), detached, with stdio `[pipe, pipe, ignore]`. It spawns Chromium detached (its own process group), logs its output, and prints `{"chromiumPid":N}` then `{"exit":{code,signal}}` on stdout.
4. Chromium launches with `--remote-debugging-port=0` bound to `127.0.0.1`; the manager polls `DevToolsActivePort` (port, then the browser WebSocket path) within `LAUNCH_TIMEOUT_MS`. Port 0 avoids the race of picking a port first.
5. Sandboxed first. If Chromium exits during launch and its log carries the sandbox failure (`SANDBOX_FAILURE_PATTERNS` in `src/chromium/args.js`), it relaunches with `--no-sandbox`, logs a warning and reports `sandbox: false`. Detection reads the **head** of the log: the message opens a long crash dump.
6. Write the run file, connect CDP, create the `browserSession`.

Launch failures are `LAUNCH_FAILED` with the log tail; a timeout kills the browser first.

**Stop:** `Browser.close` over CDP (flushes the profile), wait `STOP_GRACE_MS`, then `stop` to the keeper, then SIGKILL of both process groups. The run file goes; the profile stays.

**Delete:** stop, then rename the profile into `trash/`.

**Unexpected exit:** the keeper reports it; the browser becomes `stopped` with `lastExit` (the panel shows *Crashed*). It is not restarted.

### Browsers never outlive the backend

- The keeper is detached, so cc's process-group kill of the backend does not reach it first.
- Keeper kills Chromium's group on a `stop` line, SIGTERM/SIGINT/SIGHUP, or **stdin EOF**, which is what a SIGKILLed backend produces: SIGTERM, then SIGKILL after `KILL_GRACE_MS`.
- Backend shutdown (SIGTERM/SIGINT) closes every browser in parallel within `SHUTDOWN_GRACE_MS` (cc escalates to SIGKILL after 3 s).
- Backend boot `reap`s every run file. cc's restart overlap (the new backend starts while the old one still runs for up to 3 s) is covered by the same reap at start.
- After a backend restart every browser is `stopped` with its profile intact.

## Screencast pipeline

CDP `Page.screencastFrame` → `screencast.onFrame` (base64 decoded once; header size from the JPEG's start-of-frame) → cached `latest` → per-viewer delivery with flow control → panel draws via `createImageBitmap` and acks. Pacing and backpressure rules: [protocol.md](protocol.md#pacing-and-backpressure). Tab following rules are the pure reducer in `src/tabs.js`.

The panel socket holds a frame that arrives while no screen is subscribed (a late joiner's cached frame arrives right after `state`) and hands it to the next subscriber; dropping it would leave it un-acked and starve that viewer.

## Finding Chromium

`src/chromium/locate.js`, in order:

1. `CODE_BROWSER_CHROMIUM`. If set but the file is missing, fail loudly; never fall through.
2. The full Chrome build matching the bundled `playwright-core` (`chromium.executablePath()`), not headless-shell, so sites see real Chrome.
3. On `PATH`: `chromium`, `chromium-browser`, `google-chrome-stable`, `google-chrome` (also covers Termux).

Nothing found: `CHROMIUM_NOT_FOUND` lists every path tried and `npm --prefix <pluginDir> run install-browser`. That script is deliberately not an npm lifecycle script: it downloads a large browser, and a failure inside `npm install` would stop the panel and health route from ever coming up.

## Threat model: the shared browser's network position

Chromium runs on the cc host and browses untrusted pages. Those pages can send requests to loopback and the LAN: other local dev servers and code-hub apps, this plugin's backend (directly or through cc), and cc itself.

**Blocked today**

- **Origin == Host.** `requestRefusal` and cc's own upgrade check refuse a request whose `Origin` does not match `Host`: the panel socket, every REST mutation and `api/mcp`.
- **DNS rebinding onto the backend's own port.** Origin == Host proves nothing when an attacker hostname is rebound to `127.0.0.1` (it supplies both). A request whose `Host` names the backend's own listen port is a direct connection, so its host name must be loopback (`127.0.0.1`, `localhost`, `[::1]`); anything else is `403` on every route (health, a constant answer, excepted) and on the WebSocket. A proxied request carries the proxy's port and is not judged by this rule (`listenPort` in `src/requestGuard.js`).
- **Malformed request targets** (`//[`, `http://[`) are a `400`, and nothing a handler does on an `upgrade` can exit the process (`src/app.js`).
- **JSON content type on every state-changing route**, `api/mcp` included. A cross-origin JSON request needs a preflight, which the backend never grants; a `no-cors` or form POST goes out as `text/plain` or form-encoded and gets `415`.
- **Chromium's own CDP guards.** `--remote-allow-origins` is never passed, so Chromium refuses CDP WebSocket connections that carry an `Origin` (the backend's `ws` client sends none). Its devtools HTTP endpoints check `Host`; `/json/new` needs `PUT`; `/json/activate` and `/json/close` need an unguessable target id.
- **GET routes in this backend have no side effects.**
- CDP listens on `127.0.0.1` only.

**Still exposed (documented, not fixed)**

- Any loopback or LAN service that changes state on a `GET`, or on a `text/plain`/form `POST` without its own guard, can be triggered by a page the agent visits. That includes port probing through the CDP port's HTTP listener. The target is the other service, not code-browser.
- DNS rebinding onto **cc's own port**: cc has no `Host` allowlist, so a rebound hostname arrives with matching `Origin` and `Host`, and a request through cc's proxy is indistinguishable from a visit to cc. This is a cc-level gap; rebinding onto the backend's own port is blocked (above).
- **No loopback blocking, by design.** There is no `--host-resolver-rules` and no proxy, because agents legitimately browse local apps (`src/chromium/args.js`, `buildArgs`; `tests/args.test.mjs` asserts their absence).

Related: an agent reading untrusted pages in a logged-in shared profile can be prompt-injected.

## Testing

Run: `npm test` (backend `node --test` + panel Vitest), `npm run typecheck`, and gated `RUN_REAL_CHROMIUM=1 npm run test:e2e`.

- **Fake Chromium** (`tests/fakes/fakeChromium.mjs`): a Node script injected through `CODE_BROWSER_CHROMIUM`, run through the real keeper and launch path. It serves a CDP subset (targets, attach, screencast with ack-paced frames, navigation and history, dialogs, recorded `Input.*`) plus test-only `Fake.*` methods. Env knobs: `FAKE_CHROMIUM_REQUIRE_NO_SANDBOX`, `FAKE_CHROMIUM_NO_PORT`, `FAKE_CHROMIUM_IGNORE_CLOSE`.
- **Live stack** (`liveStack` in `tests/helpers.mjs`): real manager, session and gateway over the fake, with a second CDP client standing in for an agent.
- **Fake clock** (`fakeClock`): screencast pacing and the control lease are tested without real waits.
- **Panel tests** mock `fetch` with a tripwire (`frontend/src/test/setup.ts`); `tests/frontend-source.test.mjs` scans panel sources for banned sinks and root-relative URLs and checks the built `index.html`.
- **E2E** (`tests/e2e.real.test.mjs`): real Chromium as the shared browser, a real backend process, and Playwright's headless shell as the panel's browser (one context per viewer: pages in one context hide each other, and a hidden panel page pauses its view). It also asserts that no process for its data dir survives.
- Tests must not block the event loop of a process that hosts fixture servers: use async `spawn`, not `spawnSync`.
