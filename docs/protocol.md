# Protocol

> See also: [README](../README.md) · [features](features.md) · [architecture](architecture.md)

Interface contracts of the backend (`server.js`). All paths are relative to the plugin root; cc serves it at `/plugins/code-browser/`, which it strips before forwarding.

## Request guard

Applied by `src/app.js` to every HTTP request, in this order; no handler runs before the earlier checks pass.

| Order | Check | Refusal |
|---|---|---|
| 1 | A request that carries an `Origin` must have the same host:port as `Host` (`src/requestGuard.js`, `requestRefusal`) | `403` |
| 2 | Route lookup | `404` unknown path, `405` wrong method |
| 3 | Every state-changing route (`POST`, `DELETE`), `api/mcp` included, needs `Content-Type: application/json` | `415` |
| 4 | Body read: size cap `MAX_BODY_BYTES` (`src/limits.js`), valid JSON; an empty body reads as `{}` | `413`, `400` |

- A request with **no** `Origin` skips only check 1. cc calls `api/mcp` server-side without one.
- A foreign `Origin` is refused on `api/mcp` too, and a `text/plain` or form body is refused with `415` whatever the `Origin`.
- A WebSocket upgrade must carry an `Origin` (see below).
- Every response carries the CSP and `nosniff`, `no-referrer`, `no-store` (`src/http.js`, `SECURITY_HEADERS`), including `404`, `503` and the reply to a malformed request (`clientError`).

## REST

| Route | Body | Returns |
|---|---|---|
| `GET api/health` | — | `{ok:true}`. Never touches the browser manager. |
| `GET api/browsers` | — | `{browsers:[summary]}` |
| `POST api/browsers` | `{name}` | `201 {browser: summary}`: creates the profile and starts it; `409 EXISTS` when the name is taken |
| `POST api/browsers/:name/start` | `{}` | `{browser: summary}`; no-op when running |
| `POST api/browsers/:name/stop` | `{}` | `{browser: summary}`; the profile is kept |
| `DELETE api/browsers/:name` | — | `{ok:true}`; stops the browser and moves the profile to the trash dir |
| `POST api/mcp` | `{tool, arguments, caller}` | see MCP |

`summary` = `{name, status: "running"|"stopped", controller: "agent"|"human", sandbox: boolean|null, lastExit: {code, signal, at}|null, cdpEndpoint: string|null}`. `lastExit` is set only after an unexpected exit.

Errors are `{error: "<CODE>: <message>"}` with the status from `src/errors.js` (`statusFor`): `INVALID_NAME`/`BAD_REQUEST` 400, `FORBIDDEN` 403, `NOT_FOUND` 404, `EXISTS`/`NOT_RUNNING` 409, `PAYLOAD_TOO_LARGE` 413, `UNSUPPORTED_MEDIA_TYPE` 415, anything else 500 (`CHROMIUM_NOT_FOUND`, `LAUNCH_FAILED`).

`GET` routes have no side effects: `<img>` tags and simple requests from any page can reach them.

## Static files

- Served from `frontend/dist`: `/` and `/index.html`, and `assets/<name>.(js|css|svg|png|woff2)` (`SERVED_NAME` in `src/http.js`). Everything else is `404`; there is no SPA fallback.
- `/` answers `503` ("UI not built — run npm install") when `frontend/dist` is missing. The API still works.
- `/pluginBridge.js` and `/pluginTheme.css` are cc's host assets; standalone they are a real `404`.

## CSP

`default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'` (`src/http.js`, `CSP`). The page therefore has no inline script or style attribute.

## MCP wire format

cc POSTs `{tool, arguments, caller}` to `api/mcp` and expects HTTP `200` with one of `{result}`, `{error}` or `{text, meta?}`. `handle` in `src/mcp.js` never throws: every failure is an `{error: "<CODE>: <message>"}` body with status `200`. Tool schemas come from `conductor.plugin.json` only (flat property keys; `pattern` equals `NAME_RE`).

| Tool | Arguments | Returns |
|---|---|---|
| `list_browsers` | — | `{result: [summary]}` |
| `start_browser` | `name?` | as `browser_info`; creates the profile when the name is new; no-op when running |
| `stop_browser` | `name?` | `{result: {name, status: "stopped"}}` |
| `browser_info` | `name?` | `{text, meta}` |

`name` defaults to `default` and must match `NAME_RE` (`src/limits.js`).

`browser_info.meta`: `{name, status, cdpEndpoint, controller, sandbox, tabs: [{targetId, url, title, active}], panelPath}`.

`browser_info.text` (raw text, not escaped): the do-not-drive note when `controller` is `human`; the panel path with its relative-address note; the two Playwright rules; the ready-to-run snippet in a `js` fence (`src/snippet.js`).

Error codes: `UNKNOWN_TOOL`, `INVALID_NAME`, `NOT_FOUND`, `NOT_RUNNING`, `CHROMIUM_NOT_FOUND` (lists every path tried and the install command), `LAUNCH_FAILED` (carries the Chromium log tail), `CDP_TIMEOUT`, `CDP_ERROR`, `CDP_CLOSED`, `INTERNAL`.

## Panel shell link

`panelPath` is `/#plugin/<id>/?browser=<name>` (`src/panelLink.js`; `<id>` is `CONDUCTOR_PLUGIN_ID`, default `code-browser`).

- It is cc's route on cc's own page, `#plugin/<id>/<subpath>`; cc loads the frame at `/plugins/<id>/<subpath>`, so the panel receives `?browser=<name>`.
- It is host-relative: the backend cannot know the address the user reaches cc at. A markdown link whose target is this path works when cc is served at `/`.
- The panel itself never navigates by hash; it routes by `?browser=` only.

## Panel WebSocket: `api/ws`

- Upgrade refused with `403` unless `Origin` is present and its host:port equals `Host`; any other path is `404`.
- One socket per panel page. `ws` options: `maxPayload` = `WS_MAX_PAYLOAD`, `perMessageDeflate: false`; an oversized message closes the socket (`1009`). The server pings periodically and drops sockets that do not answer.
- Text messages are JSON. Client messages carry `msg`; server messages carry `type`. Client binary messages are refused.
- Every client message but `hello` is refused until `hello` has been accepted.

### Client → server

`needs control` = the sender's `viewerId` must hold control of the browser it is viewing; otherwise `error NOT_CONTROLLER` and nothing reaches the browser.

| `msg` | Fields | Needs control |
|---|---|---|
| `hello` | `viewerId` (8–64 chars of `A-Za-z0-9_-`; the panel keeps it in `sessionStorage` under `code-browser:viewerId`) | no |
| `view` | `name` (string, or `null` to pause), `maxWidth`, `maxHeight` | no |
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
| `state` | `name, status, sandbox, controller: {kind:"agent"} \| {kind:"human", you: boolean}, tabs: [{targetId,url,title}], activeTabId, canGoBack, canGoForward`; on `view` and on every change. A browser that stops sends `{name, status:"stopped"}` and the viewer is un-viewed. |
| `dialog` | `tabId, dialogType` (`alert`\|`confirm`\|`prompt`\|`beforeunload`), `message, defaultPrompt`; a pending dialog is replayed to a viewer that joins late |
| `dialogClosed` | `tabId` |
| `error` | `code, message`: `BAD_REQUEST`, `NOT_CONTROLLER`, `NOT_VIEWING`, `NOT_RUNNING`, `INVALID_NAME`, `INVALID_INPUT`, `BAD_URL`, `NO_TAB`, `NO_DIALOG`, `INTERNAL` |

### Binary frames

`[u32 BE headerLen][header JSON][JPEG bytes]` (`src/frame.js`). Header: `{seq, tabId, width, height, meta: {deviceWidth, deviceHeight, offsetTop, pageScaleFactor, scrollOffsetX, scrollOffsetY}}`. `width`/`height` are the JPEG's pixels; `meta.deviceWidth/Height` are the page's CSS pixels, which input coordinates use.

### Pacing and backpressure

Owned by `src/screencast.js`; the numbers are `MAX_FPS`, `VIEWER_HIGH_WATER` in `src/limits.js`.

- Chromium sends the next frame only after `Page.screencastFrameAck`; the backend acks no sooner than `1000/MAX_FPS` after the previous ack, independent of viewers.
- Each viewer has at most one frame in flight. A frame goes out only when the viewer has sent `ack` for the previous one and its socket's `bufferedAmount` is below the high-water mark; until then only the newest frame is kept (latest wins), and a retry timer delivers it once the buffer drains.
- A viewer that never acks receives no further frames. The panel acks after drawing.
- A viewer that joins gets the cached latest frame at once. A tab switch drops the cache and discards frames of the old tab.
- The screencast runs only on the active tab and only while some viewer has a view; its size is the largest viewer's request, clamped to `MAX_FRAME_DIM`.
