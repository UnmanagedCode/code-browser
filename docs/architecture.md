# Architecture

> See also: [README](../README.md) · [features](features.md) · [protocol](protocol.md) · [proxy](proxy.md)

## Stack

- **Backend:** plain ESM JavaScript, `node server.js`, `node:http`. Runtime dependencies: `ws` (the panel socket and the backend's CDP client) and `playwright-core` (Chromium lookup, and the package the agent snippet resolves). The backend never drives pages with Playwright: its own CDP client avoids Playwright's dialog auto-dismissal and extra state.
- **Panel:** React, TypeScript, Vite (`base: './'`), plain CSS on cc's theme tokens (no inline styles, so the CSP needs no `'unsafe-inline'`). Built into the gitignored `frontend/dist` by `prepare`.
- **CDP proxy:** `proxy/cdp_proxy.py`, one standard-library Python file (3.9+) the user runs on the Docker host, with its wire protocol in `proxy/protocol.json` ([proxy.md](proxy.md)).
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
src/browserManager.js    profiles and attached records (one namespace), launch/stop/delete, attach/connect, one entry per running browser
src/browserSettings.js   settings/<name>.json: the per-browser unsandboxed opt-in
src/attachStore.js       attached/<name>.json: a person's own browser, {address, via}; parseAttachTarget, the one address validator (loopback ports only) for the form and stored records
src/cdpDiscovery.js      /json/version discovery (JSON or approval mode): settles once on any outcome, with a total deadline and an abort signal
src/tunnel.js            per proxied attached browser: a 127.0.0.1:<random> forwarder, one proxied upstream per connection
src/proxyClient.js       the CDP proxy client: dial candidates, HMAC handshake, limiter
src/proxyStore.js        proxy/ rendezvous files: the secret (written) and host.json (read)
src/proxyProtocol.js     loads proxy/protocol.json (single source of the wire protocol)
proxy/cdp_proxy.py       the proxy itself, run on the Docker host (proxy/protocol.json beside it)
src/chromium/{locate,args,keeper}.js
src/runState.js          run/<name>.json, pid checks, reap
src/cdp.js               CDP client over ws
src/browserSession.js    per running browser: tabs, dialogs, nav state, input, controller, screencast
src/{tabs,controller,screencast,input,frame}.js   pure or near-pure parts of the session
src/viewerGateway.js     panel WebSocket: permissions and fan-out
frontend/src             main/App/api/socket/route/frame, components/, input/
```

One responsibility each: `browserManager` owns processes, files and the namespace (the network work of an attach is delegated to `cdpDiscovery`, `tunnel` and `proxyClient`), `browserSession` owns live state, `viewerGateway` owns the human-facing protocol and its permission checks. The REST routes, the MCP tools and the gateway call the same manager and session methods.

## On-disk layout (`$PROJECTS_ROOT/.code-browser/`)

| Path | Holds |
|---|---|
| `profiles/<name>/` | the persistent Chromium profile |
| `run/<name>.json` | `{keeperPid, chromiumPid, startedAt}` while running |
| `settings/<name>.json` | `{"allowUnsandboxed":true}`; exists only while the opt-in is on (revoking deletes it) |
| `logs/<name>.log` | Chromium output, truncated on each launch |
| `attached/<name>.json` | `{"address":"127.0.0.1:<port>","via":"proxy"\|"direct"}`: an attached browser; written when a person attaches (before the connect succeeds), removed by Forget. No secret |
| `proxy/secret.json` | the CDP proxy's shared secret (`src/proxyStore.js`); written at boot when missing or invalid |
| `proxy/host.json` | written by the proxy on the Docker host: where it listens, its pid |
| `trash/<name>-<ts>/` | a deleted profile, removed asynchronously |

Permissions (`src/fsPrivate.js`): the data dir, its top-level dirs (`profiles`, `run`, `settings`, `attached`, `proxy`, `logs`, `trash`), each profile root and each trash entry are `0700`; the plugin's run files, settings files, attached records, the proxy secret and logs are `0600`. Existing paths are tightened by chmod at boot, create and start. Files nested inside a profile are Chrome's own; the `0700` profile root shields them. The log holds visited URLs and a profile's `DevToolsActivePort` exposes CDP.

Profiles and attached records share one namespace: `names()` is their union, and a name with both is the profile's (boot warns). A malformed record is warned about once and ignored.

`NAME_RE` is the single name check for REST, MCP and the socket (the panel imports it from `src/limits.js`). A new profile is seeded with `session.restore_on_startup = 1` so session cookies (and the previous tabs) survive a stop; an existing profile's `Preferences` is never rewritten.

## Browser lifecycle

**Start** (`browserManager.start`, serialised per name; a no-op when running):

1. `reap`: kill leftovers recorded in the run file. A pid is killed only if its `/proc/<pid>/cmdline` argv still carries this profile's `--user-data-dir=<dir>` as a whole token (and, for the keeper, the keeper script as a whole token), so a recycled pid, or profile `ab` when reaping `a`, is left alone.
2. Remove stale `Singleton*` and `DevToolsActivePort` from the profile.
3. Spawn the **keeper** (`src/chromium/keeper.js`), detached, with stdio `[pipe, pipe, ignore]`. It spawns Chromium detached (its own process group), logs its output, and prints `{"chromiumPid":N}` then `{"exit":{code,signal}}` on stdout.
4. Chromium launches with `--remote-debugging-port=0` bound to `127.0.0.1`; the manager polls `DevToolsActivePort` (port, then the browser WebSocket path) within `LAUNCH_TIMEOUT_MS`. Port 0 avoids the race of picking a port first.
5. Sandboxed first. If Chromium exits during launch and its log carries the sandbox failure (`SANDBOX_FAILURE_PATTERNS` in `src/chromium/args.js`), the start is **refused** with `SANDBOX_UNAVAILABLE` unless `settings/<name>.json` holds the opt-in. The refusal launches nothing, records the name for the summary's `sandboxUnavailable` and emits `change`. With the opt-in it relaunches with `--no-sandbox`, logs a warning and reports `sandbox: false`. Detection reads the **head** of the log: the message opens a long crash dump.
6. Write the run file, connect CDP, create the `browserSession`.

Launch failures are `LAUNCH_FAILED` with the log tail; a timeout kills the browser first.

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

**The unsandboxed opt-in is a human-intent gate, not a defence against a malicious agent.** The only writer is `POST api/browsers/:name/allow-unsandboxed`, which no MCP tool reaches and which requires an `Origin` header, so a script or the MCP bridge that hits it by accident fails with `403`. An agent with shell access as the same user can still add the header or edit `settings/<name>.json`; the data dir is private to the host user, not to the agent.

Related: an agent reading untrusted pages in a logged-in shared profile can be prompt-injected.

### Attached browsers and the CDP proxy

- **Only a person attaches or connects.** No MCP tool reaches attach or connect, and both routes are `requireOrigin`, so cc's MCP bridge and plain scripts get `403`. Like the opt-in this is a **human-intent gate, not a defence against a malicious agent**: an agent with shell access can add an `Origin`, write `attached/*.json`, or read the proxy secret and dial the proxy itself.
- **Refused attach values:** a non-loopback host, a bad port, an unknown `via`, a duplicate address or browser id (including code-browser's own launched Chromium). The backend dials nothing but loopback and the proxy named in `host.json`, so the attach form is no SSRF surface.
- **Reaching the forwarded CDP:** container processes reach the tunnel on `127.0.0.1:<random>` only while connected, unauthenticated: the same bar as a launched browser's CDP port. Web pages in code-browser's own headless browser are stopped by Chrome's own guards, which the byte-transparent tunnel and proxy pass through unchanged: the `Origin` check refuses their WebSocket, a rebound hostname fails the `Host` check, `/json/new` needs `PUT`, and in approval mode `/json*` is `404`. Host processes can reach the browser's debug port directly; that is inherent to remote debugging, and approval mode adds Chrome's per-connection consent.
- **The proxy secret** stays in the backend: no summary, tool result, record or log carries it. Who holds it and what it grants: [proxy.md → Security model](proxy.md#security-model). By default the proxy forwards to `127.0.0.1:9222` only (`defaultPorts`, `proxy/protocol.json`).
- **The wire** between container and host carries CDP in clear after the handshake.

## Testing

Run: `npm test` (backend `node --test`, including the Python-gated proxy tests, + panel Vitest), `npm run typecheck`, `python3 -m unittest discover -s tests/python -v` (the proxy alone), and gated `RUN_REAL_CHROMIUM=1 npm run test:e2e` (needs a Chromium, and Python 3.9+ for step 10's proxy).

- **Fake Chromium** (`tests/fakes/fakeChromium.mjs`): a Node script injected through `CODE_BROWSER_CHROMIUM`, run through the real keeper and launch path. It serves a CDP subset (targets, attach, screencast with ack-paced frames, navigation and history, dialogs, recorded `Input.*`, every `Target.activateTarget` in `Fake.getState`) plus test-only `Fake.*` methods, and Chromium's devtools guards (`Host` must be an IP or `localhost`, a WebSocket with an `Origin` is `403`, `webSocketDebuggerUrl` built from `Host`). Env knobs: `FAKE_CHROMIUM_REQUIRE_NO_SANDBOX` (the fake writes `fake-argv.json` and `fake-pid` only after its sandbox check, so their absence proves no unsandboxed launch), `FAKE_CHROMIUM_NO_PORT`, `FAKE_CHROMIUM_IGNORE_CLOSE`, `FAKE_CHROMIUM_APPROVAL` (Chrome's approval mode: empty `404` on `/json*`, the browser upgrade held until `PUT /fake/approval?answer=allow|deny`). It exits on `Browser.close`, so a fake still alive proves none was sent.
- **External fake** (`externalFake` in `tests/helpers.mjs`): the same fake started outside code-browser, as a person's own browser.
- **Fake proxy** (`tests/fakes/fakeProxy.mjs`): an in-process stand-in that speaks the real wire protocol, so the default run covers the proxied path (cancellation, cleanup, no secret in tool results) without Python; `mode: 'blackhole'` accepts and never says hello.
- **CDP proxy:** `tests/python/test_cdp_proxy.py` (stdlib `unittest`) covers the proxy alone; `tests/proxy.test.mjs` runs that suite (and checks it ran tests) and the real proxy against the backend's client and manager (`startProxy` helper; the backend dials `127.0.0.1` through `CODE_BROWSER_PROXY_DIAL_HOST`). Python-gated and **fail closed**: without Python 3.9+ these tests fail unless `CODE_BROWSER_SKIP_PYTHON=1` skips them; `CODE_BROWSER_PYTHON` picks the interpreter. Both suites check the MAC vector in `tests/fixtures/proxy-mac-vector.json`.
- **Live stack** (`liveStack` in `tests/helpers.mjs`): real manager, session and gateway over the fake, with a second CDP client standing in for an agent.
- **Fake clock** (`fakeClock`): screencast pacing and the control lease are tested without real waits.
- **Panel tests** mock `fetch` with a tripwire (`frontend/src/test/setup.ts`); `tests/frontend-source.test.mjs` scans panel sources for banned sinks and root-relative URLs and checks the built `index.html`.
- **E2E** (`tests/e2e.real.test.mjs`): real Chromium as the shared browser, a real backend process, and Playwright's headless shell as the panel's browser (one context per viewer: pages in one context hide each other, and a hidden panel page pauses its view). Where the host has no usable sandbox it also walks the refusal, a human granting the opt-in in the panel UI, persistence across a backend restart and a revoke from the browser list; where the sandbox works those steps are skipped with a diagnostic. It also asserts that no process for its data dir survives. Step 10 attaches an externally launched real Chromium through the real proxy in the panel UI (agent use, panel control, disconnect keeps Chromium and its tabs, proxy loss and reconnect, Forget); step 11 starts a Chromium with the remote-debugging pref in its `Local State` and checks approval-mode discovery (empty `404`) and the held or refused connect, skipping with a diagnostic where no `DevToolsActivePort` appears. **Untested in CI:** clicking Allow in Chrome's native dialog (the fake covers allow, deny and pending), the automation infobar, a headed foreground screencast, Docker Desktop's `host.docker.internal` path, a native-Linux `docker0` and gateway fallback, and Google-branded Chrome's default-profile restriction.
- Tests must not block the event loop of a process that hosts fixture servers: use async `spawn`, not `spawnSync`.
