# code-browser

A shared headless Chromium for code-conductor. An agent drives it with Playwright over CDP, using its own scripts run through Bash; a person watches the same browser live in a **Browser** panel and can take control, from a desktop or a phone.

- **Agent:** `start_browser` → run the returned Playwright snippet → `browser_info` before each later script. Tabs, logins and cookies persist per browser name.
- **Person:** open the panel (cc's **Code Browser** entry, or the panel link the agent gives you) to watch, switch tabs, and take control to click, type, scroll and answer page dialogs.

Details: [docs/features.md](docs/features.md) · [docs/protocol.md](docs/protocol.md) · [docs/architecture.md](docs/architecture.md)

## Quick start

```bash
npm install                 # installs and builds the panel (frontend/dist)
npm run install-browser     # one-time Chromium download (or set CODE_BROWSER_CHROMIUM)
```

Enable the plugin in code-conductor; the backend starts on the first tool call or panel visit. Standalone: `PROJECTS_ROOT=<dir> PORT=7470 node server.js`, then open `http://127.0.0.1:7470/?browser=<name>`.

On a host where Chromium's sandbox cannot start (containers, restricted user namespaces), the first start is refused with `SANDBOX_UNAVAILABLE`. Open the panel, read the risk, and allow that browser to run without the sandbox.

Tests: `npm test`; real Chromium end to end: `RUN_REAL_CHROMIUM=1 npm run test:e2e`.

## Key defaults

- Data: `$PROJECTS_ROOT/.code-browser/` (profiles, run state, logs).
- Chromium: headless, 1280×800, CDP on a random loopback port, sandboxed; unsandboxed only for a browser a human allowed (see *Runs unsandboxed* below).
- The controller lock is advisory for agents and enforced for people (see below).

## Known limitations

- **Controller is advisory for the agent.** Agents drive Chromium over their own CDP connection, which the backend cannot pause. They are told who controls the browser; a script that ignores it can still act.
- **Network position.** Pages the shared browser visits run on the cc host and can reach loopback and LAN services. GET and simple-request side effects on other local services are exposed, DNS rebinding onto cc's port is a cc-level gap, and loopback is deliberately not blocked. See [docs/architecture.md → Threat model](docs/architecture.md#threat-model-the-shared-browsers-network-position).
- **Runs unsandboxed only where a human allowed it.** Containers and hosts that restrict unprivileged user namespaces cannot start Chromium's sandbox. There the start is refused with `SANDBOX_UNAVAILABLE` until a human turns on *Allow without sandbox* for that browser in the panel; an agent cannot. Once allowed, the browser runs with `--no-sandbox` (`sandbox: false` in `browser_info`, a *no sandbox* badge, a warning line in the `start_browser`/`browser_info` text), and a renderer compromise by a hostile page becomes code execution as the host user in a browser that holds logged-in profiles and can reach loopback. Treat such a browser as trusting every page it visits. The opt-in is a **human-intent gate, not a defence against a malicious agent**: an agent with shell access as the same user can edit `settings/` or call the route with an `Origin` header.
- **Prompt injection.** An agent browsing untrusted pages in a logged-in shared profile can be steered by them.
- Native `<select>` popups, file pickers and permission prompts do not appear in the screencast; no audio.
- Tab following is heuristic: an agent's `page.bringToFront()` is invisible to other CDP clients.
- The panel link is host-relative; the user's cc address goes in front of it.
- A backend restart stops every browser; logins and, through session restore, the open tabs come back on the next start.
- Backends run on the local System only; workers on a remote System cannot reach the loopback CDP endpoint.
- Linux only (orphan cleanup reads `/proc`). One backend per data dir.
