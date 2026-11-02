# CDP proxy (your own browser, code-browser in Docker)

> See also: [README](../README.md) · [features](features.md) · [protocol](protocol.md#cdp-proxy-wire-protocol) · [architecture](architecture.md)

A small Python program you run on the **Docker host** when code-browser runs in a container and you want to attach a browser that runs on that host ([features.md → Attach your own browser](features.md#attach-your-own-browser)). A Chrome remote-debugging port listens on the host's loopback only, which a container cannot reach; the proxy carries code-browser's connections to it.

- The container dials the proxy. Each connection authenticates with a shared secret and names one port; the proxy connects to `127.0.0.1:<port>` on the host and copies bytes both ways.
- By default it forwards **only to `127.0.0.1:9222`** (`defaultPorts` in `proxy/protocol.json`). `--ports` replaces that list. Its own port is always refused.
- Neither side is configured with an address: they find each other through files in code-browser's store.

## When you need it

| Where code-browser runs | Where your browser runs | In the attach form choose | Proxy |
|---|---|---|---|
| a container | the Docker host | *On the Docker host — through code-browser's proxy* | needed |
| directly on a machine | that machine | *On this machine — direct* | not needed |

A browser on any other machine is not supported.

## Requirements

- Python **3.9 or newer**, standard library only: nothing to `pip install`.
- The `proxy/` directory: `cdp_proxy.py` plus `protocol.json`. **Keep the two files together**; the proxy reads its protocol from `protocol.json` beside it. Run the copy from the code-browser checkout that code-browser itself runs from, so both speak the same protocol version.
- The host must see code-browser's store, `<projectsRoot>/.code-conductor/plugins/data/code-browser/`, as a directory. That holds when the projects root is a bind mount (the usual devcontainer setup on Docker Desktop and native Linux).
- code-browser has started once, so the store exists.

## Running it

| Platform | Command |
|---|---|
| Linux / macOS | `python3 proxy/cdp_proxy.py` |
| Windows | `py -3 proxy\cdp_proxy.py` |
| A debug port other than 9222 | add `--ports <port>[,<port>…]` (the list replaces the default) |

- On start it prints `code-browser-proxy listening on <ip>:<port>` (stdout), then logs (stderr) the store it found, the ports it forwards to and, if code-browser has not written its secret yet, `waiting for code-browser to create <path>`. It never logs the secret.
- Stop it with Ctrl-C or `SIGTERM` (exit code 0): it cuts every connection and removes its `host.json`. An attached browser it carried shows *Disconnected* in the panel; press **Connect** once the proxy is back.
- Before the first start of code-browser on the new store location, stop every running browser (or stop code-browser in Settings → Plugins): the migration renames the store out from under any running Chromium.
- The proxy resolves the store once, at startup: when the store moves, restart the proxy (a running one keeps reading the old location and every connection fails until then).
- Start the proxy and code-browser in either order. The backend reads `host.json` on every connection attempt.

### Discovery

The proxy finds code-browser's store by walking **up from its own script's directory** (never the working directory) to the first ancestor holding a `.code-conductor/plugins/data/code-browser` directory. Running the copy inside the projects root (the project checkout `<projectsRoot>/code-browser/proxy/cdp_proxy.py`, or a library install `<projectsRoot>/.plugins/<name>/proxy/cdp_proxy.py`) finds `<projectsRoot>/.code-conductor/plugins/data/code-browser`.

- `--projects-root <dir>` overrides the walk: the store is `<dir>/.code-conductor/plugins/data/code-browser`, which must exist.
- Finding none exits non-zero: `code-browser-proxy: no .code-conductor/plugins/data/code-browser found in any parent of <script dir> (searched: …) — start code-browser once so it creates <projectsRoot>/.code-conductor/plugins/data/code-browser, or pass --projects-root <dir>`.
- A rendezvous file it cannot create, write or read is reported as `cannot <create|write|read> <path>: <cause>`; for a permission failure it adds `— run the proxy as the user that owns <dir>`.

### Rendezvous files

Both live in `<projectsRoot>/.code-conductor/plugins/data/code-browser/proxy/` (names from `rendezvous` in `protocol.json`; shapes in [protocol.md](protocol.md#rendezvous-files)):

| File | Written by | Holds |
|---|---|---|
| `secret.json` | the backend, at every boot and connect when missing or invalid (dir `0700`, file `0600`) | the shared secret. Delete it to rotate: the backend writes a new one, and the proxy re-reads it on every connection. |
| `host.json` | the proxy, at startup (atomically, `0600`) | where the proxy listens, and its pid. Removed on a clean exit, only while it still names that pid. |

Either side reads a rendezvous file only when it is a regular file of at most `maxRendezvousBytes` (`protocol.json`), opened non-blocking, so a FIFO cannot block a read. Both write through a tmp file created exclusively in the same directory and renamed into place.

## Per-platform setup

| Setup | Proxy listens on (default) | The backend dials |
|---|---|---|
| Docker Desktop (macOS / Windows / Linux) | `127.0.0.1`, port `defaultListenPort` (`protocol.json`); there is no `docker0` on the host | `host.docker.internal` at that port: Desktop forwards it to the host's loopback |
| Native Linux Docker | the `docker0` address (e.g. `172.17.0.1`), same port | that address as written, then the container's default gateway |
| code-browser not in a container | — (choose *direct*; no proxy) | — |

- No `--listen` and no `--add-host` needed in either case.
- **Native Linux firewalls** (ufw, firewalld) may drop `docker0` → host traffic to the proxy port; allow it.
- **A host running both Docker Engine and Docker Desktop**: the default picks `docker0`; pass `--listen 127.0.0.1:<port>` for containers under Desktop.

## Configuration

| Name | Default | Meaning |
|---|---|---|
| `--ports <n,…>` | `defaultPorts` in `protocol.json` (9222) | The only `127.0.0.1` ports the proxy connects to. Replaces the default list. Any other port is `port_refused`, whose message names the `--ports` value that would allow it. |
| `--listen <ipv4:port>` | the `docker0` address if the host has one, else `127.0.0.1`; port `defaultListenPort` | The listener the backend dials (`:0` = any free port; `host.json` carries the real one). Refused when `0.0.0.0`, or the host's default-route (LAN) address. |
| `--projects-root <dir>` | the nearest parent of the script's directory holding `.code-conductor/plugins/data/code-browser` | Where code-browser's store is. |
| `CODE_BROWSER_PROXY_DIAL_HOST` (backend env, tests only) | `host.docker.internal` | The name the backend dials for a proxy on the host's loopback. |

Timings and caps (`handshakeTimeoutMs`, `connectTimeoutMs`, `maxPendingHandshakes`, `maxClientHandshakes`, `maxFrameBytes`) are in `protocol.json`, read by both sides.

## Running it as a service (Linux)

A sample systemd **system** unit (a user unit cannot order itself after `docker.service`); replace the placeholders.

```ini
[Unit]
Description=code-browser CDP proxy
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
User=<the user that owns <projectsRoot>/.code-conductor/plugins/data/code-browser>
ExecStart=/usr/bin/python3 <projectsRoot>/<path-to>/proxy/cdp_proxy.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- `Restart=on-failure` covers the store not existing yet at boot.
- Without `docker0` the proxy listens on `127.0.0.1` and stays up, unreachable from a native-Linux container; the `After=`/`Wants=docker.service` ordering makes `docker0` exist first. Pass `--listen <docker0 address>:<port>` to fail the start instead.

## Security model

- **Mutual challenge-response, secret never on the wire.** Every connection starts with the proxy's random nonce; the backend answers with its own nonce, the port, and an HMAC-SHA256 over them under the shared secret; the proxy answers with an HMAC under a different label. Each side checks the other's in constant time; the labels stop a reflected MAC, fresh nonces stop a replay. The backend uses nothing the proxy sends, data bytes included, before the proxy has proven the secret; the one exception, an `error` frame's text, is shown labelled as unverified.
- **No symlinks followed** (on Linux and macOS, which have `O_NOFOLLOW`; see Windows under Limitations). Both sides open rendezvous files with `O_NOFOLLOW`: a symlinked `secret.json` is refused by the proxy and replaced by the backend, a symlinked `host.json` is refused. Both make the rendezvous dir `0700`, an existing one included.
- **What the secret grants:** TCP to `127.0.0.1:<port>` on the Docker host, for the ports in the proxy's list only (by default `127.0.0.1:9222`), never its own port. The port is checked after authentication, so an unauthenticated client learns nothing about the list.
- **Who holds the secret:** anything that can read `<projectsRoot>/.code-conductor/plugins/data/code-browser/proxy/secret.json` (`0600`): the backend's user in the container, which includes agents' shells, and the host user. On Docker Desktop containers can already reach the host's loopback through `host.docker.internal`, so this adds little; on native Linux it extends a secret holder's reach to the listed loopback ports.
- **Impersonating the proxy** (writing `host.json`, or answering at the dial address) needs the secret too: without it no welcome MAC verifies and the backend aborts before sending a byte. An impostor sees only fresh nonces and an HMAC over them.
- **Pre-auth caps.** At most `maxPendingHandshakes` unauthenticated connections at once (one more is cut with no hello), `handshakeTimeoutMs` to authenticate, `maxFrameBytes` per line. The backend keeps at most `maxClientHandshakes` (below the cap) in flight.
- **Out of scope:** anything that can reach the listener (host processes; for a `docker0` listen, containers on bridge networks and a LAN neighbour that adds a route to it; on Docker Desktop, every container) can hold every pre-auth slot. That is a denial of service, not a bypass.
- **In clear after the handshake.** CDP travels unencrypted between container and host (the Docker bridge, or Desktop's VM network).

## Limitations

- **The browser must run on the Docker host**, and the host must see the same `.code-conductor/plugins/data/code-browser`. A named volume or remote Docker needs `--projects-root` pointing at a copy; a copied `secret.json` goes stale when the backend regenerates it.
- **Native Linux: run the proxy as the user that owns `.code-conductor/plugins/data/code-browser/proxy/`** (`0700`).
- **Only listed ports.** A browser on another debug port needs `--ports`; the panel shows the proxy's refusal with the exact flag.
- **Untested in CI:** Docker Desktop's `host.docker.internal` → host loopback path, a real native-Linux `docker0` default and gateway fallback, and Ctrl-C on Windows.
- **Python 3.9 compatibility is checked statically** (the tests parse the source with `feature_version=(3, 9)`); run the tests with `CODE_BROWSER_PYTHON=python3.9` to check it for real.
- **Windows**: the `0600`/`0700` modes do not apply on NTFS, and there is no `O_NOFOLLOW`, so a symlinked rendezvous file is followed there.
- **IPv4 only.**
