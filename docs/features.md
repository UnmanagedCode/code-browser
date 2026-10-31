# Features

> See also: [README](../README.md) · [protocol](protocol.md) · [architecture](architecture.md)

code-browser gives an agent and a person one shared headless Chromium. The agent drives it with its own Playwright scripts; the person watches, and can take over, in the **Browser** panel.

## Agent workflow

1. Call `start_browser` (optionally with a `name`). The first call starts the plugin backend and the browser.
2. Read the returned text: it carries the controller state, the panel path for the user, two rules, and a ready-to-run Playwright snippet.
3. Save the snippet as an `.mjs` file, replace `// … your steps …`, run it with `node` through Bash.
4. Before each later script call `browser_info` and respect `controller`.

- The browser keeps its tabs, logins and cookies between scripts. A script ends with `browser.close()`, which only disconnects.
- Use `browser.contexts()[0]`. `newContext()` is incognito and invisible to the panel.
- The snippet resolves `playwright-core` from the plugin's own `node_modules`; the agent's project needs no install.
- The snippet's page selection picks the tab the person is looking at (the active tab).
- Give the user the `panelPath` as is. It is relative to the address they open cc at; do not add a host.
- A browser **name** is a persistent profile: the same name keeps logins and cookies across stops, including session cookies.
- **No usable sandbox:** `start_browser` fails with `SANDBOX_UNAVAILABLE`. The error carries the `panelPath`. Tell the user to open it and enable *Allow without sandbox* for that browser, then call `start_browser` again. The agent cannot enable it: no tool or argument does. A running browser with `sandbox: false` must not browse untrusted pages.

### Tools

Arguments and return shapes: [protocol.md → MCP wire format](protocol.md#mcp-wire-format).

| Tool | Does |
|---|---|
| `list_browsers` | name, status, controller, CDP endpoint, sandbox state and the read-only `allowUnsandboxed` of every profile |
| `start_browser` | starts (creating on first use) a browser; idempotent |
| `stop_browser` | stops it; the profile is kept |
| `browser_info` | CDP endpoint, tabs, active tab, controller, `sandbox`, read-only `allowUnsandboxed`, panel path, snippet |

### The controller is advisory for the agent

The agent talks to Chromium over its own CDP connection; the backend is not on that path and cannot pause it. The agent is *told* the state: `controller` in `start_browser`/`browser_info`/`list_browsers`, and a do-not-drive note while a person holds control. A script that ignores it can still act. For the person it is enforced: see Control.

## Panel

Open it from cc's **Browser** nav entry, or from the `panelPath` link an agent gives you.

- **Browser list:** each browser with its status, who controls it, a *no sandbox* badge while Chromium runs without its sandbox, *allowed without sandbox* (with **Disallow without sandbox**) for a browser a human allowed, *not started: no sandbox* after a refused start, and *Crashed* after an unexpected exit. Open, Start/Stop, Delete (asks first). **Disallow without sandbox** on a browser that is running unsandboxed asks first, because it stops that browser now (the profile and, through session restore, the tabs and logins are kept); on any other browser it takes effect without a prompt. A Start (or New browser) that is refused for want of a sandbox opens that browser's viewer instead of showing an error. **New browser** creates and starts a profile; the name field takes `a-z`, `0-9` and `-`.
- **Viewer:** toolbar (back to the list, ← → ⟳, address bar, ⌨), tab strip, controller bar, the live screen.
- **Address bar:** Enter navigates; a bare host gets `https://`; only `http`, `https` and `about:blank` are accepted.
- **Tab strip:** each tab shows its title as plain text; selecting one switches the shared view for everyone; × and + need control.
- **Screen:** a live screencast scaled to fit. Without control it shows *Take control to interact* and sends nothing.
- **Dialogs:** a JavaScript `alert`, `confirm`, `prompt` or `beforeunload` shows as a modal with its message as text. OK and Cancel need control; the dialog offers *Take control* itself because it covers the controller bar. A dialog open before you joined is shown on arrival.
- **Stopped browsers:** the viewer shows *This browser is stopped* with a Start button.
- **Refused start (no sandbox):** the viewer shows *Not started: no usable sandbox*, the risks (the profile keeps logins and cookies, pages reach loopback and LAN services, a compromised page runs code as the host user), and **Allow without sandbox…**. That opens a confirmation step with **Allow** and **Cancel**; nothing is sent before **Allow**. Once allowed, the notice offers **Start**. The notice appears for whoever opens the browser, including after an agent's refused start.
- **Hidden page:** while the page is hidden it pauses its view, so a background tab costs the host no screencast.
- **Reconnect:** the panel reconnects with backoff and rejoins its view. While disconnected it forgets the tabs and any open dialog; the rejoin shows only what is still open.

### Control

- Three states per viewer: **Agent has control** (*Take control*), **You have control** (*Hand back*), **Another viewer has control** (*Take control*, which takes it over).
- Only the holder can send input, navigate, open or close tabs, or answer dialogs. Anyone can watch and switch the viewed tab. The backend refuses everything else with `NOT_CONTROLLER`.
- Control belongs to a viewer id kept per browser tab. If none of the holder's sockets *views* that browser for `CONTROL_LEASE_MS` (`src/limits.js`), control reverts to the agent: the panel was backgrounded (it pauses its view), the holder opened another browser or the list, or the socket closed (a phone that went to sleep). Viewing the browser again before the lease expires keeps control.

### Tab following

The active tab is one value per browser, shared by every viewer and by the screencast.

1. A new page tab becomes active (the agent opened it, or a click opened a popup).
2. A URL change on a background tab, same-document navigations included, makes it active **only while the agent has control**.
3. Closing the active tab activates the previously used one.
4. A viewer's tab selection activates that tab.

Closing the last tab opens `about:blank`. An agent's `page.bringToFront()` is invisible to other CDP clients, so following is heuristic.

### Input

| Source | Becomes |
|---|---|
| Mouse, pen | mouse messages (down, up, move, multi-click counted); wheel |
| Touch, one finger | tap → left click; drag → wheel scroll |
| Touch, pinch | the panel's own zoom; nothing reaches the page |
| Hardware keyboard | key messages; printable keys carry their text |
| Soft keyboard, IME | `beforeinput`/composition events → text, Backspace, Enter, IME composition |
| Paste | one text message |

Touch is mapped to mouse and wheel, not to CDP touch events: the shared browser is a desktop Chromium, and touch emulation would change how pages behave for the agent's scripts too. Points on the letterbox bars around the screen are dropped. The ⌨ button focuses a hidden text field to bring up a phone keyboard.

## Install and Chromium

`npm install` builds the panel (`prepare`). Chromium is **not** downloaded by npm; run `npm run install-browser` once. Lookup order and errors: [architecture.md → Finding Chromium](architecture.md#finding-chromium).
