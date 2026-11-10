# Architecture

> See also: [README](../README.md) · [features](features.md) · [protocol](protocol.md) · [host proxy](host-proxy.md)

## Stack

- **Backend:** plain ESM JavaScript, `node server.js`, `node:http`. Runtime dependencies: `ws` (the panel socket, the CDP relay and the backend's CDP client) and `playwright-core` (Chromium lookup, and the package the Bash snippet and the run_code helper load in the agent's own process). The backend never drives pages with Playwright: its own CDP client avoids Playwright's dialog auto-dismissal and extra state.
- **Panel:** React, TypeScript, Vite (`base: './'`), plain CSS on cc's theme tokens (no inline styles, so the CSP needs no `'unsafe-inline'`). Built into the gitignored `frontend/dist` by `prepare`.
- **Host proxy:** `proxy/proxy.py`, one standard-library Python file (3.9+) the user runs on the Docker host, with its wire protocol in `proxy/protocol.json` ([host-proxy.md](host-proxy.md)).
- **Plugin contract:** `conductor.plugin.json`, including `runCodeModule` (the run_code module, [protocol.md](protocol.md#run_code-module-srcruncode)). cc starts the backend lazily, passing `PORT`, `PROJECTS_ROOT` and `CONDUCTOR_PLUGIN_DATA_DIR`. Core reads only `PORT`, `CONDUCTOR_PLUGIN_ID` and the data dir; the [store migration](#store-migration) reads `PROJECTS_ROOT`. MCP calls arrive as plain `POST api/mcp` ([protocol.md](protocol.md#mcp-wire-format)).
- **No install scripts** in the runtime dependency tree (`tests/deps.test.mjs`). `package-lock.json` is gitignored.

## Modules

```
server.js                thin wiring: config → migration → manager → mcp (+ helperInfo) → installer → boot → relay token, artifacts dir → app (+ gateway, relay) → listen, graceful shutdown
src/config.js            PORT, data dir ($CONDUCTOR_PLUGIN_DATA_DIR), plugin dir, plugin id
src/migrateLegacyStore.js  one-shot boot migration of the legacy store into the data dir
src/limits.js            every tunable constant and NAME_RE
src/errors.js            CodedError (optional `details`), describeError (message + details as one string), detailsOf, and the code → HTTP status map
src/requestGuard.js      Origin↔Host check (requestRefusal); the relay's no-Origin, direct-only check (relayRefusal)
src/http.js              CSP/security headers, JSON and byte body readers, static allowlist
src/routes.js            REST table (GET handlers read-only)
src/app.js               HTTP server: guard order, dispatch, clientError, upgrade hook
src/mcp.js               dispatch (format, tool, arguments) and each tool's complete data; answers {structured}|{text,meta?}|{error,code,details?}
src/mcpViews.js          the text view of each tool, rendered from that data
src/notes.js             the warnings shown with a browser (`notes`); no imports, so the run_code helper loads it too
src/snippet.js           the Bash Playwright snippet; src/panelLink.js the shell link
src/helperInfo.js        browser_info's `helper` field: module URL, relay URL, artifacts URL, token file, artifacts dir
src/cdpRelay.js          the CDP relay (api/relay/<name>): upgrade checks, one virtual root per client, routing, controller gate, teardown
src/relayRoutes.js       the relay's routing rules as pure functions: envelope parse, command verdict, ownership, event and answer shapes
src/relayToken.js        relay/token: the bearer token for the relay and the artifacts route; checkBearer
src/artifacts.js         artifacts/: bytes a program hands the backend (POST api/artifacts), pruned to ARTIFACTS_KEEP
src/runCode/index.js     the run_code module's factory: MODULES table (null → {connect}), MODULE_UNKNOWN
src/runCode/{connect,save,pickPage}.js   connect() over the relay, save() to api/artifacts, the one page-picking rule (also the snippet's)
src/browserManager.js    profiles and attached records (one namespace), launch/stop/delete, attach/connect, one entry per running browser
src/browserSettings.js   settings/<name>.json: the per-browser unsandboxed opt-in
src/attachStore.js       attached/<name>.json: a person's own browser, {address, via}; parseAttachTarget, the one address validator (loopback ports only) for the form and stored records
src/cdpDiscovery.js      /json/version discovery (JSON or approval mode): settles once on any outcome, with a total deadline and an abort signal
src/tunnel.js            per proxied attached browser: a 127.0.0.1:<random> forwarder, one proxied upstream per connection
src/proxyClient.js       the host proxy client: dial candidates, HMAC handshake, limiter
src/proxyStore.js        proxy/ rendezvous files: the secret (written) and host.json (read)
src/proxyProtocol.js     loads proxy/protocol.json (single source of the wire protocol)
proxy/proxy.py           the proxy itself, run on the Docker host (proxy/protocol.json beside it)
src/chromium/{locate,args,keeper}.js
src/chromium/install.js  runs `playwright-core install chromium` as a child (one at a time) and holds the latest run's state for the panel
src/runState.js          run/<name>.json, pid checks, reap
src/cdp.js               CDP client over ws: send (the backend's own commands, with a timeout) and forward (relayed commands, answers in arrival order)
src/browserSession.js    per running browser: tabs, dialogs, nav state, input, controller, screencast
src/{tabs,controller,screencast,input,frame}.js   pure or near-pure parts of the session
src/viewportFit.js       launched browsers only: the page viewport follows the largest viewer's panel shape
src/viewerGateway.js     panel WebSocket: permissions and fan-out
frontend/src             main/App/api/socket/route/frame, components/, input/
```

One responsibility each: `browserManager` owns processes, files and the namespace (the network work of an attach is delegated to `cdpDiscovery`, `tunnel` and `proxyClient`), `browserSession` owns live state, `viewerGateway` owns the human-facing protocol and its permission checks, `cdpRelay` owns agent programs' CDP sockets and the controller gate on them. The REST routes, the MCP tools and the gateway call the same manager and session methods. The `src/runCode/` files run in the agent's program, not the backend: they import only `errors.js`, `limits.js`, `notes.js` and `playwright-core`, so they load under cc's plan-mode permissions.

## On-disk layout (`$CONDUCTOR_PLUGIN_DATA_DIR`)

- cc sets the variable to `<projectsRoot>/.code-conductor/plugins/data/code-browser` and never creates the dir; `manager.boot()` creates it and its missing parents `0700` (`ensurePrivateDir`).
- Unset or empty: the backend refuses to start (`CONDUCTOR_PLUGIN_DATA_DIR is not set`).


| Path | Holds |
|---|---|
| `profiles/<name>/` | the persistent Chromium profile |
| `run/<name>.json` | `{keeperPid, chromiumPid, startedAt}` while running |
| `settings/<name>.json` | `{"allowUnsandboxed":true}`; exists only while the opt-in is on (revoking deletes it) |
| `logs/<name>.log` | Chromium output, truncated on each launch |
| `attached/<name>.json` | `{"address":"127.0.0.1:<port>","via":"proxy"\|"direct"}`: an attached browser; written when a person attaches (before the connect succeeds), removed by Forget. No secret |
| `proxy/secret.json` | the host proxy's shared secret (`src/proxyStore.js`); written at boot when missing or invalid |
| `proxy/host.json` | written by the proxy on the Docker host: where it listens, its pid |
| `trash/<name>-<ts>/` | a deleted profile, removed asynchronously |
| `relay/token` | the relay's bearer token, 64 hex chars (`src/relayToken.js`); created at boot when missing, kept across boots; a file holding anything else stops the boot |
| `artifacts/` | files programs posted (`POST api/artifacts`, `<ms>-<random>.<ext>`) and the downloads of the run_code helper's Playwright (`artifactsDir`); the newest `ARTIFACTS_KEEP` files are kept |

Permissions (`src/fsPrivate.js`): the data dir, its top-level dirs (`profiles`, `run`, `settings`, `attached`, `proxy`, `logs`, `trash`, `relay`, `artifacts`), each profile root and each trash entry are `0700`; the plugin's run files, settings files, attached records, the proxy secret, the relay token, artifacts and logs are `0600`. Existing paths are tightened by chmod at boot, create and start. Files nested inside a profile are Chrome's own; the `0700` profile root shields them. The log holds visited URLs and a profile's `DevToolsActivePort` exposes CDP.

Profiles and attached records share one namespace: `names()` is their union, and a name with both is the profile's (boot warns). A malformed record is warned about once and ignored.

`NAME_RE` is the single name check for REST, MCP and the socket (the panel imports it from `src/limits.js`). A new profile is seeded with `session.restore_on_startup = 1` so session cookies (and the previous tabs) survive a stop; an existing profile's `Preferences` is never rewritten.

### Store migration

- **When:** `server.js` calls `migrateLegacyStore` after `loadConfig` and before `manager.boot()`. Boot creates the data dir and `proxy/secret.json`, which would make the move's target non-empty.
- **No-ops:** `PROJECTS_ROOT` unset or empty; no legacy dir at `<PROJECTS_ROOT>/.code-browser`; the data dir is the legacy path itself. A finished move leaves no legacy dir, so every later start is a no-op.
- **The move:** a same-filesystem `rename`, so it is atomic and keeps inodes and modes. Missing parents of the data dir are created `0700`; an existing empty data dir is replaced. It logs `code-browser: moved the store from <legacy> to <dataDir>`.
- **Refusals** (an `Error` naming both paths): data dir not empty (keep one: delete the legacy dir, or delete the data dir); `EXDEV` (different filesystems: `mv` it with code-browser stopped, or delete the legacy dir; there is no copy fallback); legacy path or an existing data dir that is not a directory.
- **A refusal stops the backend before it listens and leaves the legacy store untouched** (missing parents of the data dir may already exist, and an empty data dir may already be removed). Every refusal and error names both paths. Continuing would make boot create an empty store beside the old one, and every later start would hit "not empty".
- **Stop the browsers first.** Before the first start on the new code, stop every running browser, or stop code-browser in Settings → Plugins: the migration renames the store out from under any running Chromium and its keeper.
- **Restart the proxy after a move:** it resolves the store once at startup ([host-proxy.md](host-proxy.md#running-it)).

## Browser lifecycle

**Start** (`browserManager.start`, serialised per name; a no-op when running):

1. `reap`: kill leftovers recorded in the run file. A pid is killed only if its `/proc/<pid>/cmdline` argv still carries this profile's `--user-data-dir=<dir>` as a whole token (and, for the keeper, the keeper script as a whole token), so a recycled pid, or profile `ab` when reaping `a`, is left alone.
2. Remove stale `Singleton*` and `DevToolsActivePort` from the profile.
3. Spawn the **keeper** (`src/chromium/keeper.js`), detached, with stdio `[pipe, pipe, ignore]`. It spawns Chromium detached (its own process group), logs its output, and prints `{"chromiumPid":N}` then `{"exit":{code,signal}}` on stdout.
4. Chromium launches with `--remote-debugging-port=0` bound to `127.0.0.1`; the manager polls `DevToolsActivePort` (port, then the browser WebSocket path) within `LAUNCH_TIMEOUT_MS`. Port 0 avoids the race of picking a port first.
5. Sandboxed first. If Chromium exits during launch and its log carries the sandbox failure (`SANDBOX_FAILURE_PATTERNS` in `src/chromium/args.js`), the start is **refused** with `SANDBOX_UNAVAILABLE` unless `settings/<name>.json` holds the opt-in. The refusal launches nothing, records the name for the summary's `sandboxUnavailable` and emits `change`. With the opt-in it relaunches with `--no-sandbox`, logs a warning and reports `sandbox: false`. Detection reads the **head** of the log: the message opens a long crash dump.
6. Write the run file, connect CDP, create the `browserSession`.

Launch failures are `LAUNCH_FAILED` with the log tail in `details.logTail`; a timeout kills the browser first.

**Stop:** `Browser.close` over CDP (flushes the profile), wait `STOP_GRACE_MS`, then `stop` to the keeper, then SIGKILL of both process groups. The run file goes; the profile stays.

**Delete:** stop, remove `settings/<name>.json`, then rename the profile into `trash/`. The settings file goes first so a crash in between leaves the profile without an opt-in, never an opt-in without a profile. **Create** removes any leftover `settings/<name>.json`, so a recreated name never inherits a grant.

**Opt-in** (`browserManager.setAllowUnsandboxed`, serialised per name with start, so a start already in flight cannot slip past a revoke): writes or removes the settings file. Revoking while the browser runs with `sandbox: false` stops it at once (profile kept, `lastExit` unset: a deliberate stop); revoking while it runs sandboxed changes no process. Boot tightens existing `settings/*.json`.

**Unexpected exit:** the keeper reports it; the browser becomes `stopped` with `lastExit` (the panel shows *Crashed*). It is not restarted.

### Attached browsers

A person's own browser, attached in the panel. The manager owns only its own CDP connection (and, through the proxy, a tunnel); it never launches, stops or kills anything of it.

- **Attach** (`browserManager.attach`): validates synchronously (`parseAttachTarget`: loopback port, `via`; then name and `{address, via}` collisions), writes `attached/<name>.json` (re-pointing an attached name, disconnecting it first), then connects. The route answers `202` before the connect.
- **Connect** (serialised per name like start; `status: connecting` while queued or running):
  1. Through the proxy: `openTunnel(() => openProxied(dataDir, port))` listens on `127.0.0.1:<random>`; every connection to it is one authenticated proxied connection to `127.0.0.1:<port>` on the Docker host. Direct: the address itself.
  2. `discover(base)`: `GET /json/version` without an `Origin`. JSON → the browser socket on `base` and its id. An empty `404` → Chrome's approval mode: `ws://<base>/devtools/browser` (the id is optional there), `asksApproval`.
  3. A browser id already running under another name (another attached name, or code-browser's own launched Chromium, whose id comes from its `DevToolsActivePort`) → `EXISTS`.
  4. `CdpConnection.connect` with `APPROVAL_TIMEOUT_MS` in approval mode (Chrome holds the upgrade until the person answers), else `CDP_TIMEOUT_MS`. `403` → Chrome's refusal; a handshake timeout → nobody allowed it.
  5. The session starts with `attached: true`: `Target.getTargets` seeds the existing page tabs as background tabs (not active), then `Target.setDiscoverTargets`. `Target.activateTarget` is sent only when a screencast starts on a tab (`onStart` in `src/screencast.js`), and closing the last tab opens nothing.
  6. Any failure closes the tunnel and socket and sets `attachError` (in memory), status `stopped`.
- **Disconnect** (`stop`), **Forget** (`delete`), backend **shutdown**: close the CDP socket and the tunnel only. `Browser.close` is never sent. A connect in progress is aborted, with no `attachError`, in whichever phase it is: the attempt's `AbortSignal` cancels the proxy dial (`openProxied`), the discovery request (`discover`) and the pending upgrade (`CdpConnection.connect`), and closes the tunnel and CDP socket, so a session start in flight fails at once too. Re-attaching aborts the same way. Discovery also has a total deadline (`CDP_TIMEOUT_MS`), so a server that trickles bytes cannot hold a connect open, and it settles exactly once on any outcome: an answer cut off before its end (the browser or proxy dying mid-answer, or the abort's own tunnel close) fails it at once. A proxy dial still queued behind `maxClientHandshakes` in-flight handshakes leaves the queue on abort.
- **Start and the sandbox opt-in** refuse an attached name before taking the per-name lock (`launchedOnly` in `src/browserManager.js`), so they never wait behind a connect.
- **A failure after registration** (the session cannot be created or started) removes the entry and closes its socket and tunnel; the browser ends `stopped` with `attachError`, not *Disconnected*.
- **Unexpected close** (the browser quit, the proxy died): `stopped` with `lastExit` (*Disconnected*). No automatic retry, and no connect at boot: only a person's **Connect** (`POST …/connect`) connects. `start` refuses an attached name with `ATTACHED`.
- **Endpoints handed to agents** are on the backend's loopback: the address (direct) or the tunnel. Chrome builds `webSocketDebuggerUrl` from the `Host` it was asked through, so through the tunnel it already names the tunnel and nothing is rewritten; `Host: 127.0.0.1:<tunnel port>` passes Chrome's Host check.

### Browsers never outlive the backend

- The keeper is detached, so cc's process-group kill of the backend does not reach it first.
- Keeper kills Chromium's group on a `stop` line, SIGTERM/SIGINT/SIGHUP, or **stdin EOF**, which is what a SIGKILLed backend produces: SIGTERM, then SIGKILL after `KILL_GRACE_MS`.
- Backend shutdown (SIGTERM/SIGINT) closes every browser in parallel within `SHUTDOWN_GRACE_MS` (cc escalates to SIGKILL after 3 s).
- Backend boot `reap`s every run file. cc's restart overlap (the new backend starts while the old one still runs for up to 3 s) is covered by the same reap at start.
- After a backend restart every browser is `stopped` with its profile intact.

## CDP relay and the run_code helper

Agent programs reach a running browser through the relay (`src/cdpRelay.js`, wire contract in [protocol.md](protocol.md#cdp-relay-apirelayname)), carried over the backend's own connection (`entry.cdp`). An attached Chrome in approval mode therefore asks the person once, at Connect, and never per program; and the backend sees every command, so it enforces the controller.

- **One virtual root per client.** Chrome keeps auto-attach, target discovery, download behaviour and every child session per CDP session. Each client gets its own `Target.attachToBrowserTarget` session, attached before the upgrade completes so no message precedes it. Sharing the backend's root would hide existing pages from a second client, and a dead client's `waitForDebuggerOnStart` and `Fetch` interception would outlive it.
- **Per-browser state** (a hub per running entry, created with the first client and dropped with the last): which client owns which session, a bounded memory of released session ids (their late events are not unknown), and listeners on `entry.cdp` (`event`, `close`) and the session's `change` (the controller).
- **Order.** Relayed commands use `CdpConnection.forward`, whose `onAnswer` runs synchronously as the answer arrives, so answers and events leave in Chromium's order. Only the browser answers a forward: an abort or a closed upstream drops it unanswered, and a closed upstream ends every client through `close` (`4002`). `ws` emits every frame of one read in one go; an answer delivered through a promise would follow the events read after it, and Playwright drops an execution context whose frame it does not know yet.
- **Teardown** (`failClient`, the only path, idempotent): close with a code and a coded reason; abort the client's pending forwards (`CdpConnection` drops them, a late answer goes nowhere); detach each child on its parent session, children first (a session opened by the client's root cannot be detached from the backend's root), then the root. In-flight commands get no answer of their own: Playwright rewrites an error answer to `evaluate` as a navigation, but appends a close reason to every pending call. `Browser.close` is never sent.
- **Controller gate.** A human taking control drops every client of that browser (`4001`); a connect while a human holds control is refused (`409`), checked again after the root is attached. Clients are dropped, not paused: a paused client would keep Chrome waiting on its `waitForDebuggerOnStart`, interception and dialogs, stalling the human's own new tabs and requests.
- **The panel ignores relay sessions.** `browserSession` drops events of any session it did not open (`ownsSession`), so a client's `Target.*` events on its root never reach the panel's tabs or dialogs.
- **Shared-upstream limits.** `CDP_MAX_PAYLOAD` equals Playwright's own CDP limit: an answer over it would close `entry.cdp` (`1009`) for the panel and, for an attached Chrome, end the person's approval. `RELAY_HIGH_WATER` drops a client that does not read (checked before each send, so one maximal answer always fits).

The **run_code helper** (`src/runCode/`) runs in the agent's program. `connect()` reads `browser_info` through the program's `cc`, the token from `helper.tokenFile`, and calls Playwright's `connectOverCDP` on the relay with `artifactsDir` (`helper.artifactsDir`): without it Playwright `mkdtemp`s, which cc's plan mode (`--permission --allow-fs-read=*`) refuses. Bytes go to `POST api/artifacts` (`save`), for the same reason. The factory does no I/O, because cc memoizes a failed load for the whole run. `pickPage` is the one page-picking rule; the Bash snippet imports it by file URL.

## Screencast pipeline

CDP `Page.screencastFrame` → `screencast.onFrame` (base64 decoded once; header size from the JPEG's start-of-frame) → cached `latest` → per-viewer delivery with flow control → panel draws via `createImageBitmap` and acks. Pacing and backpressure rules: [protocol.md](protocol.md#pacing-and-backpressure). Tab following rules are the pure reducer in `src/tabs.js`.

**Titles and windows.** Chromium sends `Target.targetInfoChanged` on a cross-document navigation with a URL-shaped placeholder title, and nothing when the page's `<title>` commits or script changes `document.title`. So a running session re-reads `Target.getTargets` every `TAB_SWEEP_MS` (`src/limits.js`, timer from `src/schedule.js`, injectable as `sweep.schedule`) and applies a `synced` event: titles of tabs whose URL still matches, never the URL or the active tab. A sweep that changes nothing emits no `change`. A tab's `windowId` comes from `Browser.getWindowForTarget`, asked when a tab is created or seeded and when its target info changes (a tab dragged to another window is regrouped at its next navigation). CDP offers no tab-strip order, no favicon and no event for a person switching tabs, so `recentTabIds` (the reducer's MRU) only reflects activations through the session.

### Viewport fit

`src/viewportFit.js` is the only module that sends `Emulation.setDeviceMetricsOverride` (the width fixed at `DEFAULT_WINDOW.width`, the height from the largest viewer's aspect). Headless Chromium ignores `--window-size` for the viewport height and `Page.startScreencast` only scales a frame (never reshapes it), so without it the frame's shape is the tab's and `Screen` letterboxes.

- **Lifecycle:** `browserSession` creates one per launched session; `attach()` calls `addTab(sessionId)` after `Page.enable` (override sent at once, at the current height), `forgetTab` calls `removeTab`, `dispose()` cancels a pending apply. `screencast`'s `onViewers` feeds `setViewers(sizes)` after every viewer add, update and remove; the change is applied to every tab after `VIEWPORT_DEBOUNCE_MS` and clamped to `VIEWPORT_MIN_HEIGHT`..`VIEWPORT_MAX_HEIGHT`.
- **The gate (attached browsers are never resized):** `browserManager` sets `kind` on every running entry (`launched` or `attached`) → `createSessionForEntry` (`src/browserSession.js`, used by `server.js`) passes `attached: entry.kind !== 'launched'`, so anything not positively launched counts as a person's own browser → `browserSession` creates no `viewportFit` when `attached` → no code path sends an emulation or window-size command. `tests/browserSession.test.mjs` pins the chain (a recording CDP, panel resizes, no `Emulation.*`/`Browser.setWindowBounds`/`Browser.setContentsSize`; a source scan that those appear only in `src/viewportFit.js`, imported only by `browserSession.js`).

The panel socket holds a frame that arrives while no screen is subscribed (a late joiner's cached frame arrives right after `state`) and hands it to the next subscriber; dropping it would leave it un-acked and starve that viewer.

**Socket state** (`frontend/src/socket.ts`): `failures` counts consecutive closes since the last open; `onStatus(fn)` calls `fn(status, failures)` at once with the current state; `retry()` reconnects immediately unless connecting or open; the panel's size is stored independently of the view and sent in every `view`. `App` treats the list as current only after a `browsers` message on the open socket (`synced`), and joins a view only then.

## Finding Chromium

`src/chromium/locate.js`, in order:

1. `CODE_BROWSER_CHROMIUM`. If set but the file is missing, fail loudly; never fall through.
2. The full Chrome build matching the bundled `playwright-core` (`chromium.executablePath()`), not headless-shell, so sites see real Chrome.
3. On `PATH`: `chromium`, `chromium-browser`, `google-chrome-stable`, `google-chrome` (also covers Termux).

Nothing found: `CHROMIUM_NOT_FOUND` carries every path tried and `npm --prefix <pluginDir> run install-browser` in `details` (`tried`, `install`); an override that points nowhere carries `details.path`. REST and the panel's WebSocket add `details` and still render the extras into `error`/`message` with `describeError`. That script is deliberately not an npm lifecycle script: it downloads a large browser, and a failure inside `npm install` would stop the panel and health route from ever coming up.

### Installing from the panel

When a start fails with `CHROMIUM_NOT_FOUND` and `details.install`, the panel's notice offers **Install Chromium**. Only that click installs: nothing installs at `npm install`, at boot or on the error itself. A `details.path` failure has no offer; the override must be fixed by hand.

- `src/chromium/install.js` (`createChromiumInstaller`) spawns `process.execPath` on playwright-core's own CLI script (`resolveInstallerCli`, from the same `createRequire` copy `locateChromium` uses) with `INSTALL_ARGS`, `shell: false`, `windowsHide`, and the backend's `env`. `INSTALL_ARGS` equals the `install-browser` script in `package.json` (a test pins it).
- **No shell, no `npm`/`npx`:** on Windows those are `.cmd` shims, which current Node refuses to spawn without `shell: true`, and a shell mis-quotes paths with spaces, `&`, `%` or `^`. `execPath` is a real executable and the script path is one argv element.
- **Same copy, same directory:** the child inherits `env` and the backend's working directory (not the plugin dir): Playwright resolves a relative `PLAYWRIGHT_BROWSERS_PATH` against `INIT_CWD || process.cwd()`, so the install and the lookup resolve it identically. `PLAYWRIGHT_BROWSERS_PATH` matches and the build lands where `chromium.executablePath()` points. Playwright's installer is not in its `exports`, so it is run as a child rather than imported, which also keeps a crash or hang out of the event loop.
- **Retry finds it:** `doStart` calls `locate` on every start and nothing caches a miss, so the next start after a successful install launches.
- **State:** one run at a time per backend (`INSTALL_RUNNING`), `INSTALL_TIMEOUT_MS` deadline (the child is killed), the child is killed on shutdown (`installer.close()` in `server.js`). The state is in memory: a backend restart forgets it, and the panel shows a followed run that turns `idle` as interrupted.
- **Panel:** `useChromiumInstall` polls `GET api/chromium/install` every `INSTALL_POLL_MS` while `running` (a `setTimeout` chain, never an interval). The panel also makes one GET whenever its socket opens and shows the notice only if a run is `running`, so a reload mid-install resumes. A POST refused with `INSTALL_RUNNING` joins that run.
- **Concurrent installs:** Playwright's registry takes a `__dirlock` in its browsers directory and retries for about 10 minutes, so two backends installing at once (cc's restart overlap) are serialized by Playwright, not by code-browser.
- **Limits:** on Windows `kill()` ends the Node child only, so a download process Playwright forked may run on. A browser started during an install (an agent's `start_browser`, say) can hit a half-extracted build and fail with `LAUNCH_FAILED`.

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

**The unsandboxed opt-in is a human-intent gate, not a defence against a malicious agent.** The only writer is `POST api/browsers/:name/allow-unsandboxed`, which no MCP tool reaches and which requires an `Origin` header, so a script or the MCP bridge that hits it by accident fails with `403`. An agent with shell access as the same user can still add the header or edit `settings/<name>.json`; the data dir is private to the host user, not to the agent.

Related: an agent reading untrusted pages in a logged-in shared profile can be prompt-injected.

### The relay token

- **What it gates:** the CDP relay and `POST api/artifacts`. Through the relay an approval-mode browser is a connection the person already allowed; without a gate any process that reaches loopback could use that approval, including another OS user on the host and a client coming through cc's proxy.
- **How:** `relay/token` is private to the backend's OS user (`0600` in a `0700` dir; on Windows the data dir's default ACLs). Tool results name the file (`helper.tokenFile`) and never carry the value, which would hand it to anything that can POST `api/mcp`. The relay is also direct-only (`relayRefusal`): no `Origin`, a loopback `Host` on the backend's own port, so a proxied client is refused even with the token.
- **What it does not stop:** a process running as the same user. It can read the token, call `api/mcp`, or connect to Chromium's raw CDP port, where the controller is advisory. Like the unsandboxed opt-in above, the data dir is private to the host user, not to the agent.

### Attached browsers and the host proxy

- **Only a person attaches or connects.** No MCP tool reaches attach or connect, and both routes are `requireOrigin`, so cc's MCP bridge and plain scripts get `403`. Like the opt-in this is a **human-intent gate, not a defence against a malicious agent**: an agent with shell access can add an `Origin`, write `attached/*.json`, or read the proxy secret and dial the proxy itself.
- **Refused attach values:** a non-loopback host, a bad port, an unknown `via`, a duplicate address or browser id (including code-browser's own launched Chromium). The backend dials nothing but loopback and the proxy named in `host.json`, so the attach form is no SSRF surface.
- **Reaching the forwarded CDP:** container processes reach the tunnel on `127.0.0.1:<random>` only while connected, unauthenticated: the same bar as a launched browser's CDP port. Web pages in code-browser's own headless browser are stopped by Chrome's own guards, which the byte-transparent tunnel and proxy pass through unchanged: the `Origin` check refuses their WebSocket, a rebound hostname fails the `Host` check, `/json/new` needs `PUT`, and in approval mode `/json*` is `404`. Host processes can reach the browser's debug port directly; that is inherent to remote debugging, and approval mode adds Chrome's per-connection consent.
- **The proxy secret** stays in the backend: no summary, tool result, record or log carries it. Who holds it and what it grants: [host-proxy.md → Security model](host-proxy.md#security-model). By default the proxy forwards to `127.0.0.1:9222` only (`defaultPorts`, `proxy/protocol.json`).
- **The wire** between container and host carries CDP in clear after the handshake.

## Testing

Run: `npm test` (backend `node --test`, including the Python-gated proxy tests, + panel Vitest), `npm run typecheck`, `python3 -m unittest discover -s tests/python -v` (the proxy alone), and gated `RUN_REAL_CHROMIUM=1 npm run test:e2e` (needs a Chromium, and Python 3.9+ for step 10's proxy).

- **Fake installer CLI** (`tests/fakes/fakeInstallerCli.cjs`, CommonJS like playwright-core's CLI, because the ESM loader rejects a backslash in a module path): injected through `resolveCli` in `tests/chromiumInstall.test.mjs`, which runs the real spawn path from a directory with a space (and a backslash off Windows). Env knobs: `FAKE_INSTALL_ARGV`, `FAKE_INSTALL_LINES`, `FAKE_INSTALL_EXIT`, `FAKE_INSTALL_HANG`. No test downloads Chromium.
- **Fake Chromium** (`tests/fakes/fakeChromium.mjs`): a Node script injected through `CODE_BROWSER_CHROMIUM`, run through the real keeper and launch path. It serves a CDP subset (targets, attach, screencast with ack-paced frames, navigation and history, dialogs, recorded `Input.*`, every `Target.activateTarget` in `Fake.getState`) plus test-only `Fake.*` methods, and Chromium's devtools guards (`Host` must be an IP or `localhost`, a WebSocket with an `Origin` is `403`, `webSocketDebuggerUrl` built from `Host`). Env knobs: `FAKE_CHROMIUM_REQUIRE_NO_SANDBOX` (the fake writes `fake-argv.json` and `fake-pid` only after its sandbox check, so their absence proves no unsandboxed launch), `FAKE_CHROMIUM_NO_PORT`, `FAKE_CHROMIUM_IGNORE_CLOSE`, `FAKE_CHROMIUM_APPROVAL` (Chrome's approval mode: empty `404` on `/json*`, the browser upgrade held until `PUT /fake/approval?answer=allow|deny`). It exits on `Browser.close`, so a fake still alive proves none was sent.
- **External fake** (`externalFake` in `tests/helpers.mjs`): the same fake started outside code-browser, as a person's own browser.
- **Fake proxy** (`tests/fakes/fakeProxy.mjs`): an in-process stand-in that speaks the real wire protocol, so the default run covers the proxied path (cancellation, cleanup, no secret in tool results) without Python; `mode: 'blackhole'` accepts and never says hello.
- **Host proxy:** `tests/python/test_proxy.py` (stdlib `unittest`) covers the proxy alone; `tests/proxy.test.mjs` runs that suite (and checks it ran tests) and the real proxy against the backend's client and manager (`startProxy` helper; the backend dials `127.0.0.1` through `CODE_BROWSER_PROXY_DIAL_HOST`). Python-gated and **fail closed**: without Python 3.9+ these tests fail unless `CODE_BROWSER_SKIP_PYTHON=1` skips them; `CODE_BROWSER_PYTHON` picks the interpreter. Both suites check the MAC vector in `tests/fixtures/proxy-mac-vector.json`.
- **Fake upstream** (`tests/fakes/fakeUpstream.mjs`): the backend's `CdpConnection` scripted (handlers per method, `HOLD` to keep a command pending, `event`, `drop`), with `fakeRelayManager` standing in for the manager and session; `tests/cdpRelay.test.mjs` runs the real relay and app over it with real `ws` clients.
- **run_code helper:** `tests/runCodeModule.test.mjs` (factory routing and no-I/O with a cc whose every read throws; connect against spy servers; save; a spawned import under `--permission --allow-fs-read=*` whose cwd holds a decoy `playwright-core`), `tests/pickPage.test.mjs`.
- **Live stack** (`liveStack` in `tests/helpers.mjs`): real manager, session and gateway over the fake, with a second CDP client standing in for an agent.
- **Typed MCP:** `tests/_jsonSchemaSubset.mjs` is a test-only port of cc's `checkSchema`/`validate`; `call` in `tests/_mcpCall.mjs` asserts the reply shape of every tool call in the suite and validates json against the manifest `outputSchema`. `tests/mcp.live.test.mjs` validates replies with real session data (tabs, crash, attach failure, attached browser) and the oldest stored layout `migrateLegacyStore` can move in, all on temp data dirs. `tests/jsonSchemaSubset.test.mjs` compares the port's keyword and type sets with cc's when `CODE_CONDUCTOR_DIR` is set.
- **Config, migration, boot:** `tests/config.test.mjs` (data dir comes only from the variable; only `src/migrateLegacyStore.js` names the legacy path), `tests/migrateLegacyStore.test.mjs` (no-ops, move, modes, refusals), `tests/boot.test.mjs` (spawns `server.js`: migration precedes boot, a refusal does not listen, a missing variable refuses). A test that spawns `server.js` sets `PROJECTS_ROOT` to a fixture and `CONDUCTOR_PLUGIN_DATA_DIR` explicitly: agent shells export the real `PROJECTS_ROOT`, and `migrateLegacyStore` takes `env` with no default for the same reason.
- **Fake clock** (`fakeClock`): screencast pacing, the control lease and the title sweep are tested without real waits; `liveStack({clock})` injects it into both the controller and the sweep.
- **Titles in the fake:** `Fake.setTitle` changes a title without a `targetInfoChanged`, like Chromium; targets carry a `windowId` (`Target.createTarget` with `newWindow: true` takes a new one), answered by `Browser.getWindowForTarget`.
- **Button and input styling** lives in `frontend/src/styles.css`, mirroring cc's `button.tsx`/`input.tsx`: a plain `button` is the outline look at h-9; `data-variant` = `primary | destructive | ghost | secondary`, `data-size` = `sm | icon | icon-sm`; `aria-pressed="true"` takes the secondary look. Disabled buttons keep pointer events so their tooltips still show.
- **Tooltips:** any element with `data-tip="…"` gets a tooltip from `TooltipLayer` (mounted once in `App`): 300 ms hover/focus delay, fixed-position and clamped to the viewport, rendered as text. It is visual only: icon-only controls keep `aria-label` as their name.
- **Theme fallback guard:** `tests/theme-fallback.test.mjs` checks every `var(--x)` in `styles.css` is declared in the fallback, and, when `CODE_CONDUCTOR_DIR` points at a code-conductor checkout, that the fallback values equal its `web/src/themeTokens.css`. The fallback is a snapshot by design, so the second check is an opt-in drift check.
- **Viewport and gate tests:** `tests/viewportFit.test.mjs` (fake clock: defaults, debounce, coalescing, clamps, largest viewer), `tests/screencast.test.mjs` (`onViewers`), `tests/browserSession.test.mjs` (launched session fits; attached session records no resize command; kind gate; source guard), `tests/viewerGateway.test.mjs` (aspect-preserving clamp), `tests/limits.test.mjs` (`NAME_RE` is valid as a v-flag `pattern`). The fake Chromium lists every `Page.startScreencast`'s params in `Fake.getState`.
- **Panel tests** mock `fetch` with a tripwire (`frontend/src/test/setup.ts`); `tests/frontend-source.test.mjs` scans panel sources for banned sinks and root-relative URLs and checks the built `index.html`.
- **E2E** (`tests/e2e.real.test.mjs`): real Chromium as the shared browser, a real backend process (its `CONDUCTOR_PLUGIN_DATA_DIR` under its fixture root), and Playwright's headless shell as the panel's browser (one context per viewer: pages in one context hide each other, and a hidden panel page pauses its view). Where the host has no usable sandbox it also walks the refusal, a human granting the opt-in in the panel UI, persistence across a backend restart and a revoke from the browser list; where the sandbox works those steps are skipped with a diagnostic. It also asserts that no process for its data dir survives. Step 10 attaches an externally launched real Chromium through the real proxy in the panel UI (agent use, panel control, disconnect keeps Chromium and its tabs, proxy loss and reconnect, Forget); step 5b drives the run_code helper on the absolute-path route under `--permission --allow-fs-read=*` (a stand-in `cc` posts `browser_info` to `api/mcp`): connect, evaluate, `save` of a screenshot, `MODULE_UNKNOWN`; step 11 starts a Chromium with the remote-debugging pref in its `Local State` and checks approval-mode discovery (empty `404`) and the held or refused connect, skipping with a diagnostic where no `DevToolsActivePort` appears. **Untested in CI:** clicking Allow in Chrome's native dialog (the fake covers allow, deny and pending), the automation infobar, a headed foreground screencast, Docker Desktop's `host.docker.internal` path, a native-Linux `docker0` and gateway fallback, and Google-branded Chrome's default-profile restriction.
- **Relay E2E** (`tests/relay.real.test.mjs`, gated like the other): the real manager, session, gateway, relay and app in the test process over real Chromium, so `relay.stats().unknownDropped` is observable. Two Playwright clients at once with the panel streaming; clients that end by `browser.close()` and by SIGKILL leave no interception, init script or paused new tab behind; `Browser.close` refused and Chromium outliving every client; a new client evaluates on a tab the panel loaded (answer order); the controller gate end to end.
- **Layout E2E** (`tests/e2e.layout.real.test.mjs`, gated like the other): builds the panel with vite to a temp dir, serves it from an in-test `http` + `ws` server that answers `hello` with a fixture list and `view` with a fixture state (and can push a `dialog`), and drives it in Playwright's headless shell. It pins no horizontal overflow at 390px and 420px (touch), a sweep of 390..1000px in 10px steps (touch and mouse, a 27-character and a one-character name) with no overflow and every toolbar control and list status inside the viewport, one toolbar row at every width from 640px, switcher and dialog within the viewport, and a Tab walk that never lands on ×. `npm run test:e2e` runs every `tests/*.real.test.mjs`.
- **Panel focus:** every focus move the person did not cause (a route change, a dialog arriving) goes through `focusInPanel` (`frontend/src/focus.ts`), which does nothing unless `document.hasFocus()`; panel tests stub `document.hasFocus`. Moves a keypress or click caused call `.focus()` directly.
- Tests must not block the event loop of a process that hosts fixture servers: use async `spawn`, not `spawnSync`.
