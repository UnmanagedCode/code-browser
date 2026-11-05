# Features

> See also: [README](../README.md) · [protocol](protocol.md) · [architecture](architecture.md)

code-browser gives an agent and a person one shared headless Chromium. The agent drives it with its own Playwright scripts; the person watches, and can take over, in the **Code Browser** panel. A person can also attach a browser they run themselves (see [Attach your own browser](#attach-your-own-browser)); agents then use it through the same tools.

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
- **Viewport:** a launched browser's pages are `DEFAULT_WINDOW.width` px wide (`src/limits.js`) and their height follows the shape of the person's panel, so the screen has no letterbox bars. It can change between scripts: read `innerHeight`, and do not call `page.setViewportSize`. `browser_info` says so for launched browsers. An attached browser is never resized ([Screen](#panel)).
- A browser **name** is a persistent profile: the same name keeps logins and cookies across stops, including session cookies.
- **No usable sandbox:** `start_browser` fails with `SANDBOX_UNAVAILABLE`. The error carries the `panelPath`. Tell the user to open it and enable *Allow without sandbox* for that browser, then call `start_browser` again. The agent cannot enable it: no tool or argument does. A running browser with `sandbox: false` must not browse untrusted pages.

### Tools

Arguments and return shapes: [protocol.md → MCP wire format](protocol.md#mcp-wire-format).

| Tool | Does |
|---|---|
| `list_browsers` | name, `kind`, status, controller, CDP endpoint, sandbox state, the read-only `allowUnsandboxed`, and `attached` for an attached browser |
| `start_browser` | starts (creating on first use) a browser; idempotent. Refuses an attached browser with `ATTACHED` |
| `stop_browser` | stops it; the profile is kept. For an attached browser it only disconnects |
| `browser_info` | CDP endpoint, tabs, active tab, controller, `sandbox`, read-only `allowUnsandboxed`, `kind`, `attached`, panel path, snippet |

No tool attaches or connects a browser: only a person does, in the panel.

### The controller is advisory for the agent

The agent talks to Chromium over its own CDP connection; the backend is not on that path and cannot pause it. The agent is *told* the state: `controller` in `start_browser`/`browser_info`/`list_browsers`, and a do-not-drive note while a person holds control. A script that ignores it can still act. For the person it is enforced: see Control.

## Panel

Open it from cc's **Code Browser** nav entry, or from the `panelPath` link an agent gives you.

- **Browser list:** one row per browser: its name, a one-line status, one primary button, and a **More actions for <name>** menu.
  - **Status line** (`statusParts` in `frontend/src/browserStatus.ts`): *Running*, *Stopped* or *Connecting*, then who controls it, then warnings: *no sandbox* while Chromium runs without its sandbox, *allowed without sandbox* for a browser a human allowed, *not started: no sandbox* after a refused start, *Crashed* after an unexpected exit. An attached row's line is described under [Attach your own browser](#attach-your-own-browser).
  - **Primary button:** **Open** for a running or connecting browser, **Start** for a stopped launched one, **Connect** for a stopped attached one. Each button's accessible name carries the browser (*Open <name>*, *Start <name>*, *Connect <name>*), so rows are told apart. A Start that is refused for want of a sandbox opens that browser's viewer instead of showing an error.
  - **More actions** menu (arrow keys wrap; Escape closes it and returns focus to its button, Tab closes it and moves on; choosing an item returns focus to the button unless a confirmation or the attach form takes it): Open (when it is not the primary), Stop or Disconnect (not stopped), Change… (attached), **Disallow without sandbox** (launched, allowed), then Delete or Forget, drawn as destructive.
  - **Inline confirmations** replace native dialogs; focus starts on **Cancel**, Escape cancels, and focus returns to the row's menu button. Delete asks first; **Forget** asks first; **Disallow without sandbox** on a browser running unsandboxed asks first (**Stop and disallow**), because it stops that browser now (the profile and, through session restore, the tabs and logins are kept), and on any other browser it takes effect without a prompt.
  - **Create:** a labelled *New browser name* field with its rule beside it (`NAME_RE` in `src/limits.js`, worded in `frontend/src/names.ts`); **Create** creates and starts a profile, and a refused start opens its viewer.
  - **Attach a browser…** is a disclosure button; the attach form appears only while it is open.
  - Until the first list arrives, and after a disconnect, the list shows *Waiting for code-browser…*.
- **Viewer:** toolbar (**Browsers** back to the list, back/forward/reload, address bar, **Keyboard** on touch-capable devices only — pressed while typing goes to the page — and **Stop**, which reads **Disconnect** for an attached browser), tab strip, controller bar, the live screen. Every icon button has a tooltip. Stop and Disconnect act at once, need no control, and ask nothing, like the list's.
  - **Narrow panels:** the address bar, Keyboard and Stop/Disconnect wrap onto a second toolbar row when the panel is too narrow for one; the group's flex-basis is at least its min-content, so it wraps instead of overflowing; the address bar never shrinks below `6rem` and the browser name below `3rem`. At 30rem or less Keyboard is icon-only (its name stays *Keyboard*). The list's status lines wrap at every width instead of being cut, so warnings stay readable, and the row's buttons stay beside the name.
  - **Landmarks and focus:** the viewer and the list are each a `main` landmark headed by an `h1` (the browser's name, *Code Browser*); the screen is the active tab's `tabpanel`, and the canvas is an image named *Live view of the page*. Opening a browser focuses its name, and going back focuses that browser's row button. Focus moves like this only while the panel already has focus (`focusInPanel`, `frontend/src/focus.ts`), so a panel embedded in cc never takes focus from the host, and a deep link focuses nothing.
- **Address bar:** Enter navigates; a bare host gets `https://`; only `http`, `https` and `about:blank` are accepted.
- **Tabs:** a strip of the tabs, in window order, next to an `N tabs…` button that opens the switcher.
  - Labels are the page's title as plain text; a blank or URL-shaped title shows as host and path, and a blank page as *Untitled*. Titles are re-read about once a second (`TAB_SWEEP_MS`), because Chromium announces no title change.
  - **Switcher:** a search box filters by title and URL (every word must match; a purely numeric word matches only the real title and the URL's path, query and fragment, never the host or port, so `27` or `3000` does not select every loopback tab; other words also match the host). Arrow keys, PageUp/PageDown, Enter and Escape work from the box; a click picks too. Sort by **Window** (grouped as *Window k · n tabs*, or *n of m tabs* while filtering, when the browser has several; tabs whose window is not yet known are grouped as *Other tabs*) or **Recent**. Browser pages (`chrome:`, `about:` and similar) are hidden behind **Show browser pages**; the watched tab is always listed.
  - **Recent** reflects only switches made through code-browser (a panel pick, or a tab the agent opened or followed): Chromium reports nothing when a person switches tabs in their own window. A tab not yet shown through code-browser follows the recent ones in list order.
  - **Strip keys:** ← → Home End move focus only; Enter or Space selects; Delete closes (needs control), then focus moves to the tab that took its place (the **+** button when none is left). The watched tab scrolls into view.
  - **× is a mouse affordance:** it is hidden from assistive technology, skipped by Tab and never takes focus. Keyboard and screen-reader users close a tab with **Delete**; each tab advertises it (`aria-keyshortcuts`, and a description that says whether control is needed). The switcher button's name is *Search N tabs*; its results are announced (*N tabs match*, *No tabs match*).
  - **Badges:** *Shared* (accessible name "shared with agent") on the watched tab, which everyone watching sees and where the agent's next script starts; *Dialog* ("has open dialog") on a tab with a pending dialog.
  - Selecting a tab switches the shared view for everyone and needs no control; × and + need control. The choices (browser pages, sort) are not saved across reloads.
- **Screen:** a live screencast scaled to fit. For a launched browser the page's viewport height follows the largest viewer's panel shape, clamped to `VIEWPORT_MIN_HEIGHT`..`VIEWPORT_MAX_HEIGHT` and applied after the panel has been steady for `VIEWPORT_DEBOUNCE_MS` (`src/limits.js`), so dragging the panel does not thrash the agent's page; with no viewer the height is unchanged. An attached browser is the person's own and is never resized (no viewport, window or scale change), so its frame is letterboxed when its shape differs from the panel's. Without control it shows *Take control to interact*, a button that takes control, and sends nothing. While you have control the screen has a green frame, which turns to the focus ring while keyboard input goes to the page.
- **Dialogs:** a JavaScript `alert`, `confirm`, `prompt` or `beforeunload` shows as a modal with its message as text. OK and Cancel need control; the dialog offers *Take control* itself because it covers the controller bar. The dialog names its tab and its host (*From tab: title — host*) and, when that tab is not the watched one, offers **Show tab** (no control needed). A dialog open before you joined is shown on arrival. While one shows, the toolbar and the rest of the viewer are inert; the dialog takes focus (the prompt box, else **OK**, else **Take control**; only while the panel has focus), is described by its message, and gives focus back to what had it when it closes. Escape does not answer it.
- **Stopped browsers:** the viewer shows *This browser is stopped* with a Start button.
- **No active tab** (an attached browser whose tabs nobody has picked yet): the viewer shows *Select a tab to watch it.* and a **Find a tab…** button that opens the switcher, instead of the screen.
- **Refused start (no sandbox):** the viewer shows *Not started: no usable sandbox*, the risks (the profile keeps logins and cookies, pages reach loopback and LAN services, a compromised page runs code as the host user), and **Allow without sandbox…**. That opens a confirmation step with **Allow** and **Cancel**; nothing is sent before **Allow**. Once allowed, the notice offers **Start**. The notice appears for whoever opens the browser, including after an agent's refused start.
- **Hidden page:** while the page is hidden it pauses its view, so a background tab costs the host no screencast.
- **Reconnect:** the panel reconnects with backoff. From the first failed attempt a banner reads *Lost the connection to code-browser. Retrying (attempt N)…* with **Retry now**, then *Reconnecting… (attempt N)* while a socket is opening; it is gone once the socket opens. Screen readers hear one fixed phrase when the connection drops and *Reconnected to code-browser.* when it returns, not each attempt. While disconnected the viewer keeps the last frame and tabs, dimmed and inert (the toolbar's navigation, address bar and Keyboard are disabled; **Browsers** still works), open dialogs are forgotten, and the browser list is cleared. The panel joins a browser only after a fresh list on the new connection says it is running, so a browser stopped while the backend was away shows as stopped instead of an error.
- **Errors:** a toast at the bottom centre shows a plain sentence with the error code beneath it (`toToast` in `frontend/src/errorText.ts`). It closes itself after `TOAST_MS` (`Toast.tsx`), and stays while the pointer or keyboard focus is on it.

### Control

- Three states per viewer: **Agent has control** (*Take control*), **You have control** (*Hand back*), **Another viewer has control** (*Take control*, which takes it over).
- Only the holder can send input, navigate, open or close tabs, or answer dialogs. Anyone can watch and switch the viewed tab. The backend refuses everything else with `NOT_CONTROLLER`.
- Control belongs to a viewer id kept per browser tab. If none of the holder's sockets *views* that browser for `CONTROL_LEASE_MS` (`src/limits.js`), control reverts to the agent: the panel was backgrounded (it pauses its view), the holder opened another browser or the list, or the socket closed (a phone that went to sleep). Viewing the browser again before the lease expires keeps control.

### Tab following

The active tab is one value per browser, shared by every viewer and by the screencast. It is also the agent's tab: the script `browser_info` hands out starts on it, which the panel shows as the *Shared* badge.

1. A new page tab becomes active (the agent opened it, or a click opened a popup).
2. A URL change on a background tab, same-document navigations included, makes it active **only while the agent has control**.
3. Closing the active tab activates the previously used one.
4. A viewer's tab selection activates that tab.

Closing the last tab opens `about:blank`, except in an attached browser. In an attached browser, the person's existing tabs are listed without becoming active (rule 1 applies to tabs opened after it connects). An agent's `page.bringToFront()` is invisible to other CDP clients, so following is heuristic.

### Input

| Source | Becomes |
|---|---|
| Mouse, pen | mouse messages (down, up, move, multi-click counted); wheel |
| Touch, one finger | tap → left click; drag → wheel scroll |
| Touch, pinch | the panel's own zoom; nothing reaches the page |
| Hardware keyboard | key messages; printable keys carry their text |
| Soft keyboard, IME | `beforeinput`/composition events → text, Backspace, Enter, IME composition |
| Paste | one text message |

Touch is mapped to mouse and wheel, not to CDP touch events: the shared browser is a desktop Chromium, and touch emulation would change how pages behave for the agent's scripts too. Points on the letterbox bars around the screen are dropped. The **Keyboard** button (shown on touch-capable devices) focuses a hidden text field to bring up a phone keyboard; pressing it again closes the keyboard.

## Attach your own browser

A person can attach a Chrome (or Chromium) they run themselves, with its own tabs and logins. Agents then use it through `browser_info` and their Playwright scripts like any shared browser; the panel watches and controls it the same way.

### 1. Turn on remote debugging in your browser

| Way | How | What you get |
|---|---|---|
| **Your normal profile** (Chrome 144 and later) | Open `chrome://inspect/#remote-debugging` and tick *Allow remote debugging for this browser instance*. The page shows *Server running at: 127.0.0.1:<port>*. | Chrome asks *Allow remote debugging?* for **every connection**: code-browser's Connect, and **each agent script**. While any connection is open Chrome shows *Chrome is being controlled by automated test software*. |
| **A dedicated profile** | Start Chrome with `--remote-debugging-port=9222 --user-data-dir=<a dedicated dir>` (since Chrome 136 the port flag is ignored on the default profile). | No prompts; a separate profile with its own logins. |

Command lines for a dedicated profile:

| OS | Command |
|---|---|
| Linux | `google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-debug"` |
| macOS | `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-debug"` |
| Windows | `"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%LOCALAPPDATA%\chrome-debug` |

Never add `--remote-allow-origins`: Chrome's refusal of WebSocket connections that carry an `Origin` is what keeps web pages away from the debug port.

### 2. Attach it in the panel

In the browser list, **Attach a browser…** opens the form:

- **Name:** `a-z`, `0-9`, `-`; one namespace with code-browser's own browsers.
- **Debug address:** `127.0.0.1:<port>` or `localhost:<port>` (default `127.0.0.1:9222`): the *Server running at* address on `chrome://inspect/#remote-debugging`, or your `--remote-debugging-port`. Chrome's debug server listens on loopback only, so nothing else is accepted.
- **Where the browser runs:**
  - *On the Docker host — through code-browser's proxy*: code-browser runs in a container and the browser on its Docker host. Start the proxy there first ([proxy.md](proxy.md)). The proxy forwards only to port 9222 unless it was started with `--ports`.
  - *On this machine — direct*: code-browser runs directly on the machine where the browser runs.
- **Cancel** closes the form and returns to the button. **Attach** saves the browser and connects, then closes the form. The row shows *connecting*; if Chrome asks *Allow remote debugging?*, click **Allow**. A failed connect shows its reason on the row as text (for example Chrome's refusal, nothing listening, or the proxy's `--ports` hint).

An attached row's status line reads the status, *attached*, *via proxy* or *direct*, the address, *asks approval* when Chrome asks per connection, who controls it, and *Disconnected* after the connection dropped. **Connect** is its primary button when it is stopped; the rest are in its menu:

| Item | Does |
|---|---|
| **Disconnect** | closes code-browser's connection; cancels a connect that waits on Chrome's dialog |
| **Change…** | opens the form prefilled, scrolls it into view and focuses *Name*; attaching under the same name re-points it |
| **Forget** | asks first, disconnects and removes the entry; the browser and its tabs are untouched |

There are no sandbox controls: code-browser did not launch the browser and cannot vouch for its sandbox or profile (`sandbox` is `null`).

The viewer of a disconnected attached browser shows *This browser is disconnected.*, the last error, and **Connect**; while connecting it shows the *click Allow* hint.

### What agents can and cannot do

- **Use it:** `browser_info` gives a loopback CDP endpoint, the tabs, the controller and a snippet. The snippet opens the agent's **own tab** when no tab is active, and the text tells it not to close tabs it did not open.
- **Disconnect it:** `stop_browser` closes code-browser's connection only.
- **Never attach or reconnect it:** `start_browser` on an attached browser is refused with `ATTACHED` and the panel path; the agent asks the person to press **Connect**. A disconnect may be deliberate (the person closed Chrome or pressed Disconnect), and in approval mode a reconnect would raise a dialog nobody asked for.
- **Approval mode:** each script opens a new connection, so Chrome asks again for each one. The text tells the agent to warn the person before each script and to use as few scripts as possible; a script waits until **Allow** and fails with `403` on cancel.

Nothing code-browser does closes the browser or its tabs: Disconnect, Forget, `stop_browser` and a backend shutdown close only code-browser's own connection and proxy tunnel. After a backend restart the browser is listed *stopped* and is never connected again on its own.

### Headed browsers

- Watching a tab in the panel brings it to the front in the person's window (screencasts of background tabs need it).
- A minimised or fully covered window may produce no frames.
- The controller covers panel viewers only: the person at the browser's own window can always act.
- While an agent's script is connected, Playwright auto-dismisses JavaScript dialogs on every tab, the person's included.

## Install and Chromium

`npm install` builds the panel (`prepare`). Chromium is **not** downloaded by npm; run `npm run install-browser` once. Lookup order and errors: [architecture.md → Finding Chromium](architecture.md#finding-chromium).
