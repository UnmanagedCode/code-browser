# Protocol

> See also: [README](../README.md) · [features](features.md) · [architecture](architecture.md)

Interface contracts of the backend (`server.js`). All paths are relative to the plugin root; cc serves it at `/plugins/code-browser/`, which it strips before forwarding.

## Request guard

Applied by `src/app.js` to every HTTP request, in this order; no handler runs before the earlier checks pass.

| Order | Check | Refusal |
|---|---|---|
| 0 | A request target that is not a valid URL | `400` (after the Origin check, so a foreign Origin still gets `403`) |
| 1 | A request that carries an `Origin` must have the same host:port as `Host`; and a `Host` that names the backend's own port must be a loopback name (`127.0.0.1`, `localhost`, `[::1]`). `api/health` skips the loopback rule. (`src/requestGuard.js`, `requestRefusal`) | `403` |
| 2 | Route lookup | `404` unknown path, `405` wrong method |
| 2b | A route marked `requireOrigin` (the panel-only routes, below) needs an `Origin` header | `403` |
| 3 | Every state-changing route (`POST`, `DELETE`), `api/mcp` included, needs `Content-Type: application/json` | `415` |
| 4 | Body read: size cap `MAX_BODY_BYTES` (`src/limits.js`), valid JSON; an empty body reads as `{}` | `413`, `400` |

- A request with **no** `Origin` skips only check 1. cc calls `api/mcp` server-side without one.
- A foreign `Origin` is refused on `api/mcp` too, and a `text/plain` or form body is refused with `415` whatever the `Origin`.
- A **panel-only route** (`requireOrigin` in `src/routes.js`: `POST api/browsers/:name/allow-unsandboxed`, `…/attach`, `…/connect`, `POST api/chromium/install`) additionally refuses a request with **no** `Origin` (`403`, before the content-type check). A browser always sends `Origin` on a `fetch` POST and cc's proxy passes it through, so the panel is unaffected; cc's MCP bridge and plain scripts send none. This is not a defence against a client that adds the header.
- A WebSocket upgrade must carry an `Origin` (see below).
- Every response carries the CSP and `nosniff`, `no-referrer`, `no-store` (`src/http.js`, `SECURITY_HEADERS`), including `404`, `503` and the reply to a malformed request (`clientError`).

## REST

| Route | Body | Returns |
|---|---|---|
| `GET api/health` | — | `{ok:true}`. Never touches the browser manager. |
| `GET api/browsers` | — | `{browsers:[summary]}` |
| `GET api/chromium/install` | — | `{install: InstallState}`: the latest Chromium install run of this backend (in memory; `idle` until one starts). Read-only, and subject to the loopback-`Host` rule |
| `POST api/chromium/install` | `{}` | `202 {install: InstallState}` (status `running`); panel-only (needs `Origin`); `409 INSTALL_RUNNING` while one runs (one per backend); `500 INSTALL_UNAVAILABLE` (`details.install`) when `playwright-core` is not installed. No MCP tool starts it |
| `POST api/browsers` | `{name}` | `201 {browser: summary}`: creates the profile and starts it; `409 EXISTS` when the name is taken |
| `POST api/browsers/:name/start` | `{}` | `{browser: summary}`; no-op when running; `409 ATTACHED` for an attached browser |
| `POST api/browsers/:name/stop` | `{}` | `{browser: summary}`; the profile is kept. An attached browser is disconnected (code-browser's own connection and tunnel close; nothing is sent to the browser) and a connect in progress is cancelled |
| `POST api/browsers/:name/allow-unsandboxed` | `{allow: boolean}` | `{browser: summary}`; panel-only (needs `Origin`); `allow: false` stops the browser if it runs unsandboxed; `400 BAD_REQUEST` when `allow` is not a boolean or the browser is attached |
| `POST api/browsers/:name/attach` | `{address, via}` | `202 {browser: summary}` (status `connecting`); panel-only. Saves `attached/<name>.json` (re-pointing an attached name) and connects in the background. `address`: `127.0.0.1:<port>` or `localhost:<port>` (port 1–65535; canonicalised to `127.0.0.1`); `via`: `proxy` \| `direct`; anything else `400 BAD_ENDPOINT`. `409 EXISTS` when the name is a profile or another attached browser has the same `{address, via}` |
| `POST api/browsers/:name/connect` | `{}` | `202 {browser: summary}` (status `connecting`); panel-only; connects an attached browser in the background; `400 BAD_REQUEST` for a profile, `404 NOT_FOUND` for an unknown name |
| `DELETE api/browsers/:name` | — | `{ok:true}`; stops the browser and moves the profile to the trash dir. For an attached browser: disconnects and removes the record only |
| `POST api/mcp` | `{tool, arguments, caller, format}` | see MCP |

`summary` = `{name, kind: "launched"|"attached", status: "running"|"stopped"|"connecting", controller: "agent"|"human", sandbox: boolean|null, allowUnsandboxed: boolean, sandboxUnavailable: boolean, lastExit: {code, signal, at}|null, cdpEndpoint: string|null, attached: {address, via, asksApproval: boolean|null}|null, attachError: string|null}`. `lastExit` is set only after an unexpected exit (for an attached browser: the connection dropped; the panel shows *Disconnected*). `allowUnsandboxed` is the human's per-browser opt-in to run without Chromium's sandbox. `sandboxUnavailable` is true after a start was refused for want of a sandbox, until a start succeeds or the browser is deleted; it is held in memory and does not survive a backend restart.

Attached browsers (`kind: "attached"`, a person's own browser):

- `status` `connecting` while an attach or connect is in progress (attached only).
- `attached`: the saved `address` and `via`, and `asksApproval` (Chrome's approval mode, known once discovery has run; `null` before), `null` for launched browsers.
- `attachError`: why the last connect failed, held in memory; cleared by the next attach or connect.
- `sandbox` is `null`, `allowUnsandboxed` and `sandboxUnavailable` are `false`.
- `cdpEndpoint` is a URL on the backend's own loopback: `http://127.0.0.1:<port>` (direct), `http://127.0.0.1:<tunnel port>` (through the proxy), or `ws://…/devtools/browser` in approval mode. It never carries the proxy secret.

Errors are `{error: "<CODE>: <message>"}` (plus `details` when the error carries extras) with the status from `src/errors.js` (`statusFor`): `INVALID_NAME`/`BAD_REQUEST`/`BAD_ENDPOINT` 400, `FORBIDDEN` 403, `NOT_FOUND` 404, `EXISTS`/`NOT_RUNNING`/`SANDBOX_UNAVAILABLE`/`ATTACHED`/`INSTALL_RUNNING` 409, `PAYLOAD_TOO_LARGE` 413, `UNSUPPORTED_MEDIA_TYPE` 415, anything else 500 (`CHROMIUM_NOT_FOUND`, `LAUNCH_FAILED`, `INSTALL_UNAVAILABLE`). A failed connect of an attached browser has no HTTP status: attach and connect answer `202` before connecting, and the failure arrives as the summary's `attachError` (an `ATTACH_FAILED` or `EXISTS` message).

A `CodedError` that carries machine-readable extras also returns them as `details`: `CHROMIUM_NOT_FOUND` has `tried` + `install`, or `path`; `LAUNCH_FAILED` has `logTail`. `error` still renders them as text through `describeError` in `src/errors.js` (the tried paths, the install command, the log tail), so a caller that reads only `error` loses nothing. An error without extras has no `details` key.

`InstallState` = `{status: "idle"|"running"|"succeeded"|"failed", error: string|null, exitCode: number|null, logTail: string}`. `logTail` is the last `LOG_TAIL_CHARS` of the installer's stdout and stderr with `\r\n`/`\r` as `\n`; it is installer output, so a client renders it as text. A run still `running` after `INSTALL_TIMEOUT_MS` is killed and becomes `failed`. The panel polls `GET` every `INSTALL_POLL_MS` while `running`, and once whenever its socket opens.

`GET` routes have no side effects: `<img>` tags and simple requests from any page can reach them.

## Static files

- Served from `frontend/dist`: `/` and `/index.html`, and `assets/<name>.(js|css|svg|png|woff2)` (`SERVED_NAME` in `src/http.js`). Everything else is `404`; there is no SPA fallback.
- `/` answers `503` ("UI not built — run npm install") when `frontend/dist` is missing. The API still works.
- `/pluginBridge.js` and `/pluginTheme.css` are cc's host assets; standalone they are a real `404`.

## CSP

`default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'` (`src/http.js`, `CSP`). The page therefore has no inline script or style attribute.

## MCP wire format

cc POSTs `{tool, arguments, caller, format}` to `api/mcp`. `handle` in `src/mcp.js` never throws and always answers HTTP `200`. Tool input schemas and output schemas come from `conductor.plugin.json` only (flat property keys; the input `pattern` equals `NAME_RE`; output schemas stay inside cc's validated vocabulary: every object states `additionalProperties`, no `pattern`/`$ref`/`oneOf`).

Check order in `handle`: `format`, then `tool`, then `arguments`, then the tool.

| Request | Reply |
|---|---|
| `format: "json"` | `{structured}` and no other key: the tool's complete data, validated by cc against the tool's `outputSchema`. Nothing is capped. |
| `format: "text"`, or `format` absent (an older cc sends none) | `{text, meta?}` and no other key: prose for the agent (`src/mcpViews.js`) |
| any other `format` (including `null`) | `{error, code: "FORMAT_UNKNOWN"}` |
| a refusal, either format | `{error, code, details?}`: `code` matches `^[A-Z][A-Z0-9_]*$`, `error` is the message without the code, `details` is a plain object of machine-readable extras (never a stack) |

| Tool | Arguments | json (`structured`) | text |
|---|---|---|---|
| `list_browsers` | — | `{browsers: [summary]}`, every browser | one line per browser using the json field names with JSON-literal values, then a hint to call `browser_info` |
| `start_browser` | `name?` | as `browser_info`; creates the profile when the name is new; no-op when running | as `browser_info` |
| `stop_browser` | `name?` | `{name, kind, status: "stopped"}` | one sentence; for an attached browser it says code-browser only disconnected and that only the user reconnects |
| `browser_info` | `name?` | `{...summary, tabs, activeTargetId, panelPath, notes, rules, snippet}` | `{text, meta}` |

`name` defaults to `default` and must match `NAME_RE` (`src/limits.js`). No tool attaches or connects a browser, and every tool takes `name` only; other arguments (such as `allowUnsandboxed`) are ignored. `arguments` must be an object (`BAD_REQUEST` otherwise).

`summary` is the shape of `manager.summary()` (the REST fields above): `name, kind, controller, status, cdpEndpoint, sandbox, allowUnsandboxed, sandboxUnavailable, lastExit, attached, attachError`, all always present. The schema is written out in full in `conductor.plugin.json` for `list_browsers` and for `browser_info`/`start_browser` (cc's subset has no `$ref`); `tests/manifest.test.mjs` pins the copies equal.

`browser_info` json, beyond the summary:

- `tabs`: `[{targetId, url, title, active}]`, every tab; `activeTargetId`.
- `panelPath`: `/#plugin/<id>/?browser=<name>`, relative to the address the user opens cc at; do not add a host.
- `notes`: the warnings that apply now, in text order: the do-not-drive note when `controller` is `human`; the `WARNING` when `sandbox` is `false`; for an attached browser the attached note (`ATTACHED_NOTE` in `src/mcp.js`: the user's tabs and logins, work in your own tab, do not close tabs you did not open, `sandbox` is null, `stop_browser` only disconnects and only the user reconnects, a person may be using the window); when `attached.asksApproval` the approval note (`APPROVAL_NOTE`: every script's connection raises Chrome's dialog, tell the user first, use few scripts).
- `rules`: the Playwright rules (the viewport rule only for launched browsers).
- `snippet`: the whole ready-to-run script (`src/snippet.js`: for an attached browser with no active tab it opens its own tab; in approval mode `connectOverCDP` waits `APPROVAL_TIMEOUT_MS`).

`browser_info` text: each note followed by a blank line, the `Panel:` line with its relative-address note, `Rules:` as `- ` bullets, then the snippet in a `js` fence. `meta` is `{name, kind, status, attached, cdpEndpoint, controller, sandbox, allowUnsandboxed, tabs, panelPath}`; the json-only fields (`lastExit`, `attachError`, `sandboxUnavailable`, `activeTargetId`) are a text summary, not a cap.

Refusals (`code`, with `details`):

| Code | When | `details` |
|---|---|---|
| `FORMAT_UNKNOWN` | `format` is not `text` or `json` | — |
| `TOOL_UNKNOWN` | unknown, missing, non-string or prototype (`toString`, `constructor`) tool | — |
| `BAD_REQUEST` | `arguments` is not an object | — |
| `INVALID_NAME` | `name` fails `NAME_RE` | — |
| `NOT_FOUND` | `stop_browser`/`browser_info` on an unknown name | — |
| `NOT_RUNNING` | `browser_info` on a stopped browser | launched: `{name, kind: "launched"}`; attached: `{name, kind: "attached", panelPath}`, and the message says it is the user's own browser and to ask them to press Connect |
| `SANDBOX_UNAVAILABLE` | `start_browser` with no usable sandbox and no human opt-in; the message says only a human can enable *Allow without sandbox* | `{name, panelPath}` |
| `ATTACHED` | `start_browser` on an attached browser; the message says to ask the user to Connect it | `{name, panelPath}` |
| `CHROMIUM_NOT_FOUND` | no Chromium | `{tried, install}`, or `{path}` for a missing `CODE_BROWSER_CHROMIUM` |
| `LAUNCH_FAILED` | Chromium did not come up | `{logTail}` for a launch that timed out or exited; other causes have a message only |
| `EXISTS`, `CDP_TIMEOUT`, `CDP_ERROR`, `CDP_CLOSED` | the manager's own refusals | — |
| `INTERNAL` | anything else: the message is `<tool> failed unexpectedly: <cause>`; a raw system code such as `ENOENT` is never the `code` | — |

## Panel shell link

`panelPath` is `/#plugin/<id>/?browser=<name>` (`src/panelLink.js`; `<id>` is `CONDUCTOR_PLUGIN_ID`, default `code-browser`).

- It is cc's route on cc's own page, `#plugin/<id>/<subpath>`; cc loads the frame at `/plugins/<id>/<subpath>`, so the panel receives `?browser=<name>`.
- It is host-relative: the backend cannot know the address the user reaches cc at. A markdown link whose target is this path works when cc is served at `/`.
- The panel itself never navigates by hash; it routes by `?browser=` only.

## Panel WebSocket: `api/ws`

- Upgrade refused with `403` unless `Origin` is present and its host:port equals `Host` (and the loopback rule above holds); a malformed target is `400`; any other path is `404`.
- One socket per panel page. `ws` options: `maxPayload` = `WS_MAX_PAYLOAD`, `perMessageDeflate: false`; an oversized message closes the socket (`1009`). The server pings periodically and drops sockets that do not answer.
- Text messages are JSON. Client messages carry `msg`; server messages carry `type`. Client binary messages are refused.
- Every client message but `hello` is refused until `hello` has been accepted.

### Client → server

`needs control` = the sender's `viewerId` must hold control of the browser it is viewing; otherwise `error NOT_CONTROLLER` and nothing reaches the browser.

| `msg` | Fields | Needs control |
|---|---|---|
| `hello` | `viewerId` (8–64 chars of `A-Za-z0-9_-`; the panel keeps it in `sessionStorage` under `code-browser:viewerId`) | no |
| `view` | `name` (string, or `null` to pause), `maxWidth`, `maxHeight` (the panel sends `view` only after a `browsers` list on the current connection, and always its real size) | no |
| `viewport` | `maxWidth`, `maxHeight` | no |
| `ack` | `seq` | no |
| `control` | `action`: `take` \| `release` (release: holder only) | no |
| `tab` | `action`: `activate` (+`tabId`) \| `new` \| `close` (+`tabId`) | `activate` no; `new`, `close` yes |
| `nav` | `action`: `goto` (+`url`) \| `back` \| `forward` \| `reload` | yes |
| `input` | `kind`, see below | yes |
| `dialog` | `tabId`, `action`: `accept` \| `dismiss`, `promptText?` | yes |

`input` kinds (`src/input.js`, `inputToCdp`; every field validated and clamped, failures are `INVALID_INPUT`):

| `kind` | Fields | CDP |
|---|---|---|
| `mouse` | `action` `down`\|`up`\|`move`, `x`, `y` (page CSS px), `button`, `buttons`, `clickCount`, `modifiers` | `Input.dispatchMouseEvent` |
| `wheel` | `x`, `y`, `deltaX`, `deltaY`, `modifiers` | `Input.dispatchMouseEvent` `mouseWheel` |
| `key` | `action` `down`\|`up`, `key`, `code`, `keyCode`, `location`, `modifiers`, `autoRepeat`, `text?` | `Input.dispatchKeyEvent`: `keyDown` with `text` when present, `rawKeyDown` otherwise, `keyUp` |
| `text` | `text` | `Input.insertText` (also paste) |
| `ime` | `text`, `selectionStart`, `selectionEnd` | `Input.imeSetComposition` |

`modifiers` is CDP's bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8.

`nav goto` URLs go through `normalizeUrl`: a bare host gets `https://`; only `http:`, `https:` and `about:blank` pass, anything else is `BAD_URL`. `back`/`forward` walk `Page.getNavigationHistory`.

### Server → client

| `type` | Fields |
|---|---|
| `browsers` | `list: [summary]`, on `hello` and on every change |
| `state` | `name, status, sandbox` (`null` for an attached browser)`, controller: {kind:"agent"} \| {kind:"human", you: boolean}, tabs: [{targetId,url,title,windowId}] (`windowId` is `null` until known), activeTabId, recentTabIds (tab ids, most recently shown through code-browser first), canGoBack, canGoForward`; on `view` and on every change. A browser that stops sends `{name, status:"stopped"}` and the viewer is un-viewed. |
| `dialog` | `tabId, dialogType` (`alert`\|`confirm`\|`prompt`\|`beforeunload`), `message, defaultPrompt`; a pending dialog is replayed to a viewer that joins late |
| `dialogClosed` | `tabId` |
| `error` | `code, message, details?` (extras rendered into `message` too; no viewer message reaches `CHROMIUM_NOT_FOUND` or `LAUNCH_FAILED`): `BAD_REQUEST`, `NOT_CONTROLLER`, `NOT_VIEWING`, `NOT_RUNNING`, `INVALID_NAME`, `INVALID_INPUT`, `BAD_URL`, `NO_TAB`, `NO_DIALOG`, `INTERNAL` |

### Binary frames

`[u32 BE headerLen][header JSON][JPEG bytes]` (`src/frame.js`). Header: `{seq, tabId, width, height, meta: {deviceWidth, deviceHeight, offsetTop, pageScaleFactor, scrollOffsetX, scrollOffsetY}}`. `width`/`height` are the JPEG's pixels; `meta.deviceWidth/Height` are the page's CSS pixels, which input coordinates use.

### Pacing and backpressure

Owned by `src/screencast.js`; the numbers are `MAX_FPS`, `VIEWER_HIGH_WATER` in `src/limits.js`.

- Chromium sends the next frame only after `Page.screencastFrameAck`; the backend acks no sooner than `1000/MAX_FPS` after the previous ack, independent of viewers.
- Each viewer has at most one frame in flight. A frame goes out only when the viewer has sent `ack` for the previous one and its socket's `bufferedAmount` is below the high-water mark; until then only the newest frame is kept (latest wins), and a retry timer delivers it once the buffer drains.
- A viewer that never acks receives no further frames. The panel acks after drawing.
- A viewer that joins gets the cached latest frame at once. A tab switch drops the cache and discards frames of the old tab.
- The screencast runs only on the active tab and only while some viewer has a view; its size is the largest viewer's request. A `view` or `viewport` size above `MAX_FRAME_DIM` is scaled down as a whole (`fitDims` in `src/viewerGateway.js`), keeping its aspect.
- For a **launched** browser the largest viewer by area (`maxWidth * maxHeight`, both > 0) also sets the page viewport's height from its aspect, after a debounce ([architecture.md](architecture.md#viewport-fit)); an attached browser is never resized.

## Host proxy wire protocol

Between the backend (client, `src/proxyClient.js`) and `proxy/proxy.py` on the Docker host. Every value named here lives in `proxy/protocol.json`, which both sides read (`src/proxyProtocol.js`); nothing restates it. Running and security model: [host-proxy.md](host-proxy.md).

**Transport:** raw TCP, the backend dials. Newline-delimited JSON frames (`frames`), each at most `maxFrameBytes`, until the handshake ends; after `welcome` the connection is a byte pipe to `127.0.0.1:<port>` on the host.

| Step | Frame | Fields |
|---|---|---|
| 1. proxy → client | `hello` | `v` (`protocolVersion`), `nonce` (`nonceBytes` random bytes, base64url) |
| 2. client → proxy | `auth` | exactly `t, v, nonce, port, mac`: the client's own nonce, the target port (an integer in `port.min`–`port.max`), `mac` = client MAC |
| 3. proxy → client | `welcome` \| `error` | `welcome`: `mac` = proxy MAC. `error`: `code`, `message` |

- **MAC:** lowercase hex HMAC-SHA256 under the secret over `label + "\n" + nonce_proxy + "\n" + nonce_client + "\n" + port` (decimal), with `macLabels.client` for the client and `macLabels.proxy` for the proxy. Compared in constant time. `tests/fixtures/proxy-mac-vector.json` is a vector both test suites check.
- **Order of checks (proxy):** the auth frame's shape (`bad_frame`) and version (`version_mismatch`), the secret (`no_secret`), the MAC (`auth_failed`), the port (`port_refused`), then the connect to `127.0.0.1:<port>` within `connectTimeoutMs` (`connect_failed`). The port list is only checked after the MAC.
- **Port policy:** allowed ports are `defaultPorts` unless `--ports` replaces them; the proxy's own listen port is always refused. A `port_refused` message names the `--ports` value that would allow the port.
- **Client side:** it uses nothing after `hello` (data bytes included) before the proxy MAC verifies; otherwise it fails with `impostor`. One exception: an `error` frame comes before any proof, so its `message` is passed on to `attachError` labelled `unverified: this peer has not proved the secret`, never as the proxy's own diagnosis.
- **Dial candidates:** failing to *reach* a candidate (connection refused or timed out, no hello in time, an impostor) moves to the next candidate. An `error` frame carrying one of the `errorCodes` (such as `connect_failed` or `port_refused`) stops dialling: a proxy answered, and another address would not answer differently.
- **Caps:** `maxPendingHandshakes` unauthenticated connections at the proxy (one more is cut with no hello); `handshakeTimeoutMs` per handshake on both sides; the backend runs at most `maxClientHandshakes` handshakes at once.
- **Error codes** (`errorCodes`): `auth_failed`, `version_mismatch`, `no_secret`, `bad_frame`, `port_refused`, `connect_failed`. Backend-only failure codes: `no_proxy` (no `host.json`: start the proxy), `bad_host_file`, `impostor`, `closed`, `timeout`. They reach the panel inside `attachError` as `through the proxy: …`.

### Rendezvous files

In `<dataDir>/proxy/` (`rendezvous.dir`). Each has one writer; both are read only as a regular file of at most `maxRendezvousBytes`, opened non-blocking.

| File | Writer | Shape |
|---|---|---|
| `rendezvous.backendFile` (`secret.json`) | backend (`ensureSecret` in `src/proxyStore.js`), at boot and before each proxied connection, when missing or invalid; `0600` in a `0700` dir | `{protocolVersion, secret}`; `secret` at least `minSecretLength` characters |
| `rendezvous.proxyFile` (`host.json`) | proxy, at startup; removed on a clean exit while it names that pid; `0600` | `{protocolVersion, listen: "<ipv4>:<port>", pid}`. Another `protocolVersion` is reported as `update the proxy/ copy on the host` |
