# code-browser

A shared headless Chromium for code-conductor. An agent drives it with Playwright over CDP, using its own scripts run through Bash; a person watches the same browser live in a **Code Browser** panel and can take control, from a desktop or a phone.

- **Agent:** `start_browser` → run the returned Playwright snippet → `browser_info` before each later script. Tabs, logins and cookies persist per browser name.
- **Person:** open the panel (cc's **Code Browser** entry, or the panel link the agent gives you) to watch, switch tabs, and take control to click, type, scroll and answer page dialogs.
- **Your own browser:** a person can attach a Chrome they run themselves in the panel; agents then use it through the same tools, and code-browser only ever disconnects from it. Through Docker, a small host-side proxy carries the connection: [docs/proxy.md](docs/proxy.md).

Details: [docs/features.md](docs/features.md) · [docs/protocol.md](docs/protocol.md) · [docs/architecture.md](docs/architecture.md) · [docs/proxy.md](docs/proxy.md)

## Quick start

```bash
npm install                 # installs and builds the panel (frontend/dist)
npm run install-browser     # one-time Chromium download (or click Install Chromium in the panel, or set CODE_BROWSER_CHROMIUM)
```

Enable the plugin in code-conductor; the backend starts on the first tool call or panel visit. Standalone: `CONDUCTOR_PLUGIN_DATA_DIR=<dir> PORT=7470 node server.js`, then open `http://127.0.0.1:7470/?browser=<name>`. The boot migration also reads `PROJECTS_ROOT`: from a shell that exports it, a legacy store found under it is moved into `<dir>`; unset `PROJECTS_ROOT` to start empty ([details](docs/architecture.md#store-migration)).

On a host where Chromium's sandbox cannot start (containers, restricted user namespaces), the first start is refused with `SANDBOX_UNAVAILABLE`. Open the panel, read the risk, and allow that browser to run without the sandbox.

Tests: `npm test` (includes the CDP proxy's Python tests: needs Python 3.9+, or `CODE_BROWSER_SKIP_PYTHON=1` to skip them explicitly); real Chromium end to end: `RUN_REAL_CHROMIUM=1 npm run test:e2e` (also needs Python 3.9+: it runs the proxy).

## Key defaults

- Data: `$CONDUCTOR_PLUGIN_DATA_DIR` (cc sets `<projectsRoot>/.code-conductor/plugins/data/code-browser`): profiles, run state, logs; see [architecture.md → On-disk layout](docs/architecture.md#on-disk-layout-conductor_plugin_data_dir).
- Chromium: headless, 1280 px wide with the viewport height following the panel ([features](docs/features.md)), CDP on a random loopback port, sandboxed; unsandboxed only for a browser a human allowed (see *Runs unsandboxed* below).
- The controller lock is advisory for agents and enforced for people (see below).

## Known limitations

- **Controller is advisory for the agent.** Agents drive Chromium over their own CDP connection, which the backend cannot pause. They are told who controls the browser; a script that ignores it can still act.
- **Network position.** Pages the shared browser visits run on the cc host and can reach loopback and LAN services. GET and simple-request side effects on other local services are exposed, DNS rebinding onto cc's port is a cc-level gap, and loopback is deliberately not blocked. See [docs/architecture.md → Threat model](docs/architecture.md#threat-model-the-shared-browsers-network-position).
- **Runs unsandboxed only where a human allowed it.** Containers and hosts that restrict unprivileged user namespaces cannot start Chromium's sandbox. There the start is refused with `SANDBOX_UNAVAILABLE` until a human turns on *Allow without sandbox* for that browser in the panel; an agent cannot. Once allowed, the browser runs with `--no-sandbox` (`sandbox: false` in `browser_info`, a *no sandbox* warning on the browser's status line, a warning in the `start_browser`/`browser_info` result (`notes`)), and a renderer compromise by a hostile page becomes code execution as the host user in a browser that holds logged-in profiles and can reach loopback. Treat such a browser as trusting every page it visits. The opt-in is a **human-intent gate, not a defence against a malicious agent**: an agent with shell access as the same user can edit `settings/` or call the route with an `Origin` header.
- **Attached browsers:** the browser must run on the Docker host (through the proxy), or on the machine code-browser runs on (direct); through the proxy the projects root must be a bind mount the host sees, and the proxy forwards only to `127.0.0.1:9222` unless started with `--ports` ([docs/proxy.md](docs/proxy.md)). In Chrome's own-profile mode (`chrome://inspect/#remote-debugging`) Chrome asks the person to allow every connection, each agent script included. A headed window that is minimised or covered may send no frames. Attaching and connecting are a human-intent gate, not a defence against an agent with shell access.
- **Prompt injection.** An agent browsing untrusted pages in a logged-in shared profile can be steered by them.
- Native `<select>` popups, file pickers and permission prompts do not appear in the screencast; no audio.
- Tab following is heuristic: an agent's `page.bringToFront()` is invisible to other CDP clients.
- The panel link is host-relative; the user's cc address goes in front of it.
- A backend restart stops every browser; logins and, through session restore, the open tabs come back on the next start.
- Backends run on the local System only; workers on a remote System cannot reach the loopback CDP endpoint.
- Linux only (orphan cleanup reads `/proc`). One backend per data dir.
