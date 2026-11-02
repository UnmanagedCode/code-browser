"""code-browser CDP proxy.

Runs on the Docker HOST and lets a containerised code-browser reach a browser's
remote-debugging port on this host's loopback. code-browser dials OUT to this
proxy. Every connection authenticates on its own (a mutual HMAC
challenge-response over a shared secret; the secret never crosses the wire) and
names one port; the proxy then connects to 127.0.0.1:<port> on this host and
splices the two byte-for-byte. It connects nowhere else: only to 127.0.0.1,
only to an allowed port (defaultPorts in protocol.json unless --ports replaces
that list), and never to its own port. Python 3.9+, standard library only.

The two sides meet through a rendezvous directory in code-browser's store
(<projectsRoot>/.code-conductor/plugins/data/code-browser/proxy/): code-browser writes the shared secret
there, the proxy writes its listen address. The wire protocol (frames, MAC
labels, caps, timings, error codes) lives in protocol.json next to this file;
keep the two files together. See docs/proxy.md and docs/protocol.md.
"""

import argparse
import asyncio
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import signal
import socket
import stat
import struct
import sys
from pathlib import Path

if sys.version_info < (3, 9):
    sys.exit("code-browser proxy needs Python 3.9 or newer")


PROTOCOL = json.loads(Path(__file__).with_name("protocol.json").read_text(encoding="utf-8"))
VERSION = PROTOCOL["protocolVersion"]
RENDEZVOUS = PROTOCOL["rendezvous"]
LABELS = PROTOCOL["macLabels"]
FRAMES = PROTOCOL["frames"]
ERROR_CODES = PROTOCOL["errorCodes"]
PORT_MIN, PORT_MAX = PROTOCOL["port"]["min"], PROTOCOL["port"]["max"]
DEFAULT_PORTS = tuple(PROTOCOL["defaultPorts"])
DEFAULT_LISTEN_PORT = PROTOCOL["defaultListenPort"]
NONCE_BYTES = PROTOCOL["nonceBytes"]
MAX_RENDEZVOUS_BYTES = PROTOCOL["maxRendezvousBytes"]
MAX_FRAME_BYTES = PROTOCOL["maxFrameBytes"]
MAX_PENDING_HANDSHAKES = PROTOCOL["maxPendingHandshakes"]
HANDSHAKE_TIMEOUT_S = PROTOCOL["handshakeTimeoutMs"] / 1000.0
CONNECT_TIMEOUT_S = PROTOCOL["connectTimeoutMs"] / 1000.0

# Proxy-only limits.
PUMP_CHUNK = 65536
LISTEN_BACKLOG = 128
KEEPALIVE_IDLE_S = 15
KEEPALIVE_INTERVAL_S = 5

# cc's CONDUCTOR_PLUGIN_DATA_DIR for manifest id `code-browser`, relative to the projects root. This directory is
# meant to be copyable on its own, so the id is hardcoded here; a test guards it against conductor.plugin.json.
STORE_RELPATH = Path(".code-conductor", "plugins", "data", "code-browser")
# The only host the proxy ever connects to, and its fallback listen address.
LOOPBACK_HOST = "127.0.0.1"
SIOCGIFADDR = 0x8915
DOCKER0 = b"docker0"

NONCE_RE = re.compile(r"\A[A-Za-z0-9_-]{%d}\Z" % ((NONCE_BYTES * 8 + 5) // 6))
MAC_RE = re.compile(r"\A[0-9a-f]{64}\Z")

# The auth frame: exactly these keys, each of exactly this type (so a JSON
# true is not a port).
AUTH_SHAPE = {"t": str, "v": int, "nonce": str, "port": int, "mac": str}


def log(msg):
    print("code-browser-proxy: " + msg, file=sys.stderr, flush=True)


def default_route_ipv4():
    """The source address of the default route (the host's LAN address).

    A UDP connect() to a documentation address (TEST-NET-1) only makes the
    kernel pick a route; no datagram is ever sent.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.0.2.1", 9))
        return sock.getsockname()[0]
    finally:
        sock.close()


def docker0_ipv4():
    """The IPv4 address of the docker0 bridge (native Linux Docker), or None."""
    if not sys.platform.startswith("linux"):
        return None
    try:
        import fcntl
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            packed = fcntl.ioctl(sock.fileno(), SIOCGIFADDR, struct.pack("256s", DOCKER0))
        finally:
            sock.close()
        return socket.inet_ntoa(packed[20:24])
    except (OSError, ImportError):
        return None


def default_listen_host(docker0=docker0_ipv4):
    """Where the listener goes without --listen: the docker0 address a
    native-Linux container reaches the host on, else loopback (Docker Desktop
    forwards host.docker.internal to the host's loopback)."""
    return docker0() or LOOPBACK_HOST


def listen_problem(listen_host, default_route):
    """Why the listener would be reachable from the LAN, or None.

    `listen_host` is a canonical IPv4 (parse_args), `default_route` the host's
    LAN address or None. Refuses the wildcard and the LAN address; a loopback
    listener is always allowed. On some other LAN interface, the
    challenge-response handshake is the remaining gate.
    """
    addr = ipaddress.IPv4Address(listen_host)
    if addr.is_unspecified:
        return "--listen %s is a wildcard address, which would expose the proxy on every interface" % listen_host
    if addr.is_loopback:
        return None
    if listen_host == default_route:
        return "--listen %s is this host's default-route (LAN) address, so LAN devices could reach the proxy" % listen_host
    return None


# --- rendezvous ---------------------------------------------------------------

def find_store(script_path, override=None):
    """(store_dir or None, searched): code-browser's data directory, STORE_RELPATH.

    With `override` (--projects-root), <override>/STORE_RELPATH. Otherwise the
    nearest ancestor of the script's directory holding STORE_RELPATH as a
    directory, so the answer never depends on the working directory.
    """
    if override is not None:
        root = Path(override).resolve()
        store = root / STORE_RELPATH
        return (store if store.is_dir() else None), [str(root)]
    searched = []
    for parent in Path(script_path).resolve().parent.parents:
        searched.append(str(parent))
        if (parent / STORE_RELPATH).is_dir():
            return parent / STORE_RELPATH, searched
    return None, searched


class RendezvousError(Exception):
    """A rendezvous file or directory can't be used; the message says why."""


def file_problem(action, path, e, rdir):
    """`cannot <action> <path>: <cause>`, plus the fix when the cause is permissions."""
    msg = "cannot %s %s: %s" % (action, path, e.strerror or e)
    if isinstance(e, PermissionError):
        msg += " — run the proxy as the user that owns %s" % rdir
    return msg


def proxy_dir(store):
    path = Path(store) / RENDEZVOUS["dir"]
    try:
        os.makedirs(str(path), mode=0o700, exist_ok=True)
        os.chmod(str(path), 0o700)  # an existing dir too, as the backend does
    except OSError as e:
        raise RendezvousError(file_problem("create", path, e, Path(store)))
    return path


class SecretUnavailable(Exception):
    pass


def read_small_file(path):
    """The text of `path` if it is a regular file of at most maxRendezvousBytes.

    Opened non-blocking and without following a symlink, and checked on the
    open descriptor, so a FIFO can't block the event loop, a planted link isn't
    followed and a huge file can't bloat it. Raises OSError for an I/O failure
    (a symlink included), ValueError for a file that isn't usable.
    """
    fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("%s is not a regular file" % path)
        if info.st_size > MAX_RENDEZVOUS_BYTES:
            raise ValueError("%s is larger than %d bytes" % (path, MAX_RENDEZVOUS_BYTES))
        # A read may return less than asked: read on until EOF or one byte past the bound.
        data = b""
        while len(data) <= MAX_RENDEZVOUS_BYTES:
            chunk = os.read(fd, MAX_RENDEZVOUS_BYTES + 1 - len(data))
            if not chunk:
                break
            data += chunk
    finally:
        os.close(fd)
    if len(data) > MAX_RENDEZVOUS_BYTES:
        raise ValueError("%s is larger than %d bytes" % (path, MAX_RENDEZVOUS_BYTES))
    return data.decode("utf-8")


def read_secret(rdir):
    """The secret code-browser wrote, re-read on every call so a regenerated one
    applies at once. Raises SecretUnavailable naming the path and the cause."""
    path = Path(rdir) / RENDEZVOUS["backendFile"]
    try:
        raw = read_small_file(path)
    except OSError as e:
        raise SecretUnavailable(file_problem("read", path, e, rdir))
    except ValueError as e:
        raise SecretUnavailable(str(e))
    try:
        obj = json.loads(raw)
    except ValueError as e:
        raise SecretUnavailable("%s is not valid JSON: %s" % (path, e))
    secret = obj.get("secret") if isinstance(obj, dict) else None
    if not isinstance(secret, str) or len(secret) < PROTOCOL["minSecretLength"]:
        raise SecretUnavailable("%s holds no secret of at least %d characters" % (path, PROTOCOL["minSecretLength"]))
    return secret


def write_host_json(rdir, listen, pid):
    """Atomically publish where the proxy listens (tmp file in the same dir,
    created exclusively, then renamed). Raises RendezvousError saying why."""
    path = Path(rdir) / RENDEZVOUS["proxyFile"]
    tmp = Path(rdir) / (".%s.%d.tmp" % (RENDEZVOUS["proxyFile"], pid))
    payload = json.dumps({"protocolVersion": VERSION, "listen": listen, "pid": pid}) + "\n"
    try:
        if os.path.lexists(str(tmp)):
            os.unlink(str(tmp))
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        if hasattr(os, "fchmod"):  # the create mode is narrowed by the umask
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
        os.replace(str(tmp), str(path))
    except OSError as e:
        raise RendezvousError(file_problem("write", path, e, rdir))
    return path


def remove_host_json_if_ours(rdir, pid):
    """Remove host.json only while it still names `pid`: a newer proxy's file stays."""
    path = Path(rdir) / RENDEZVOUS["proxyFile"]
    try:
        obj = json.loads(read_small_file(path))
    except (OSError, ValueError):
        return False
    if not isinstance(obj, dict) or obj.get("pid") != pid:
        return False
    try:
        path.unlink()
    except OSError:
        return False
    return True


# --- frames and the handshake --------------------------------------------------

class BadFrame(Exception):
    pass


def encode(frame):
    return json.dumps(frame, separators=(",", ":")).encode("utf-8") + b"\n"


def parse_frame(line):
    try:
        msg = json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise BadFrame("not a JSON line")
    if not isinstance(msg, dict) or not isinstance(msg.get("t"), str):
        raise BadFrame("not an object with a string t")
    return msg


def check_shape(obj, shape, what):
    if set(obj) != set(shape):
        raise BadFrame("%s must have exactly the keys %s" % (what, ", ".join(sorted(shape))))
    for key, kind in shape.items():
        if type(obj[key]) is not kind:
            raise BadFrame("%s: %s must be %s" % (what, key, kind.__name__))


def mac(secret, label, nonce_proxy, nonce_client, port):
    msg = "\n".join((label, nonce_proxy, nonce_client, str(port)))
    return hmac.new(secret.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()


def verify_mac(expected, given):
    """Constant-time comparison of a MAC against the expected one."""
    if not isinstance(given, str):
        return False
    return hmac.compare_digest(expected.encode("utf-8"), given.encode("utf-8"))


# --- sockets --------------------------------------------------------------------

def set_keepalive(writer):
    sock = writer.get_extra_info("socket")
    if sock is None:
        return
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        if hasattr(socket, "TCP_KEEPIDLE"):
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, KEEPALIVE_IDLE_S)
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, KEEPALIVE_INTERVAL_S)
        elif sys.platform == "darwin" and hasattr(socket, "TCP_KEEPALIVE"):
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPALIVE, KEEPALIVE_IDLE_S)
        elif hasattr(socket, "SIO_KEEPALIVE_VALS") and hasattr(sock, "ioctl"):
            sock.ioctl(socket.SIO_KEEPALIVE_VALS, (1, KEEPALIVE_IDLE_S * 1000, KEEPALIVE_INTERVAL_S * 1000))
    except OSError:
        pass


def bind_listener(host, port):
    """A listening, non-blocking TCP socket on host:port."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if sys.platform == "win32":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))
        sock.listen(LISTEN_BACKLOG)
        sock.setblocking(False)
    except OSError:
        sock.close()
        raise
    return sock


async def pump(reader, writer, other):
    """Copy reader → writer until EOF; on an error, abort both connections."""
    try:
        while True:
            data = await reader.read(PUMP_CHUNK)
            if not data:
                break
            writer.write(data)
            await writer.drain()
        if writer.can_write_eof() and not writer.is_closing():
            writer.write_eof()
    except (ConnectionError, OSError):
        writer.transport.abort()
        other.transport.abort()


class Proxy:
    """Accepts connections, authenticates each, and splices it to 127.0.0.1:<port>."""

    def __init__(self, rdir, ports, listen_port):
        self.proxy_dir = rdir
        self.ports = tuple(ports)
        self.listen_port = listen_port
        self.pending_handshakes = 0
        self.writers = set()
        self.closing = False

    def port_problem(self, port):
        """Why the proxy won't connect to 127.0.0.1:`port`, or None."""
        if port == self.listen_port:
            return "port %d is this proxy's own port" % port
        if port not in self.ports:
            wanted = ",".join(str(p) for p in sorted(set(self.ports) | {port}))
            return ("port %d is not allowed: this proxy forwards only to %s — start the proxy with --ports %s"
                    % (port, ",".join(str(p) for p in self.ports), wanted))
        return None

    def close(self):
        self.closing = True
        for writer in list(self.writers):
            writer.transport.abort()
        self.writers.clear()

    async def handle(self, reader, writer):
        if self.closing or self.pending_handshakes >= MAX_PENDING_HANDSHAKES:
            writer.transport.abort()
            return
        self.pending_handshakes += 1
        self.writers.add(writer)
        try:
            try:
                then = await asyncio.wait_for(self._handshake(reader, writer), HANDSHAKE_TIMEOUT_S)
            except asyncio.TimeoutError:
                writer.transport.abort()
                return
            finally:
                self.pending_handshakes -= 1
            if then is not None:
                await then()
        except Exception as e:  # never let one connection take the proxy down
            log("connection failed: %r" % (e,))
            writer.transport.abort()
        finally:
            self.writers.discard(writer)

    async def _refuse(self, writer, code, message):
        writer.write(encode({"t": FRAMES["error"], "code": code, "message": message}))
        try:
            await writer.drain()
        finally:
            writer.close()

    async def _handshake(self, reader, writer):
        """Authenticate one connection and open its target. Returns what to run
        once it is no longer pre-auth, or None when it was refused or dropped."""
        nonce_proxy = secrets.token_urlsafe(NONCE_BYTES)
        writer.write(encode({"t": FRAMES["hello"], "v": VERSION, "nonce": nonce_proxy}))
        await writer.drain()
        try:
            line = await reader.readline()
        except (ValueError, ConnectionError):
            writer.transport.abort()
            return None
        if not line.endswith(b"\n"):
            writer.transport.abort()
            return None
        try:
            msg = parse_frame(line)
            if msg["t"] != FRAMES["auth"]:
                raise BadFrame("expected an auth frame")
        except BadFrame as e:
            await self._refuse(writer, ERROR_CODES["badFrame"], str(e))
            return None
        if msg.get("v") != VERSION:
            await self._refuse(writer, ERROR_CODES["versionMismatch"],
                               "this proxy speaks protocol %d, the client %r — update the proxy/ copy on the host" % (VERSION, msg.get("v")))
            return None
        try:
            check_shape(msg, AUTH_SHAPE, "an auth frame")
            if not NONCE_RE.match(msg["nonce"]):
                raise BadFrame("malformed nonce")
            if not MAC_RE.match(msg["mac"]):
                raise BadFrame("malformed mac")
            if not PORT_MIN <= msg["port"] <= PORT_MAX:
                raise BadFrame("port %d is outside %d-%d" % (msg["port"], PORT_MIN, PORT_MAX))
        except BadFrame as e:
            await self._refuse(writer, ERROR_CODES["badFrame"], str(e))
            return None
        try:
            secret = read_secret(self.proxy_dir)
        except SecretUnavailable as e:
            log(str(e))
            await self._refuse(writer, ERROR_CODES["noSecret"], str(e))
            return None
        port = msg["port"]
        expected = mac(secret, LABELS["client"], nonce_proxy, msg["nonce"], port)
        if not verify_mac(expected, msg["mac"]):
            log("refused a connection: wrong MAC")
            await self._refuse(writer, ERROR_CODES["authFailed"], "authentication failed")
            return None
        problem = self.port_problem(port)
        if problem:
            log("refused a connection: " + problem)
            await self._refuse(writer, ERROR_CODES["portRefused"], problem)
            return None
        try:
            up_reader, up_writer = await asyncio.wait_for(asyncio.open_connection(LOOPBACK_HOST, port), CONNECT_TIMEOUT_S)
        except (OSError, asyncio.TimeoutError) as e:
            why = "timed out" if isinstance(e, asyncio.TimeoutError) else (e.strerror or str(e))
            await self._refuse(writer, ERROR_CODES["connectFailed"],
                               "nothing listens on %s:%d on the Docker host (%s) — is Chrome's remote debugging on?" % (LOOPBACK_HOST, port, why))
            return None
        proof = mac(secret, LABELS["proxy"], nonce_proxy, msg["nonce"], port)
        return lambda: self._splice(reader, writer, up_reader, up_writer, proof)

    async def _splice(self, reader, writer, up_reader, up_writer, proof):
        if self.closing:
            writer.transport.abort()
            up_writer.transport.abort()
            return
        self.writers.add(up_writer)
        writer.write(encode({"t": FRAMES["welcome"], "mac": proof}))
        set_keepalive(writer)
        set_keepalive(up_writer)
        try:
            # close() aborts both writers, which ends both pumps.
            await asyncio.gather(pump(reader, up_writer, writer), pump(up_reader, writer, up_writer), return_exceptions=True)
        finally:
            self.writers.discard(up_writer)
            for w in (writer, up_writer):
                w.close()


def parse_ports(value):
    """The ports of a --ports value, deduplicated, order kept. Raises ValueError."""
    ports = []
    for part in (p.strip() for p in value.split(",")):
        if not part:
            continue
        if not part.isdigit() or not PORT_MIN <= int(part) <= PORT_MAX:
            raise ValueError("%r is not a port (%d-%d)" % (part, PORT_MIN, PORT_MAX))
        if int(part) not in ports:
            ports.append(int(part))
    if not ports:
        raise ValueError("no port given")
    return ports


def parse_args(argv, default_host=default_listen_host):
    parser = argparse.ArgumentParser(
        prog="cdp_proxy.py",
        description="Let a containerised code-browser reach a browser's remote-debugging port on this host's loopback.")
    parser.add_argument("--listen", metavar="IP:PORT",
                        help="listener code-browser dials (default: the docker0 address, else 127.0.0.1, port %d)"
                        % DEFAULT_LISTEN_PORT)
    parser.add_argument("--projects-root", metavar="DIR",
                        help="code-browser's projects root, holding .code-conductor/plugins/data/code-browser (default: the nearest parent of this "
                             "script's directory that has one)")
    parser.add_argument("--ports", metavar="N[,N...]",
                        help="the only 127.0.0.1 ports the proxy forwards to (default: %s)"
                        % ",".join(str(p) for p in DEFAULT_PORTS))
    args = parser.parse_args(argv)
    if args.listen is None:
        args.listen = "%s:%d" % (default_host(), DEFAULT_LISTEN_PORT)
    # Canonicalised once, here: the canonical string is both what the guard
    # checks and what is bound.
    host, _, port = args.listen.rpartition(":")
    try:
        args.listen_host = str(ipaddress.IPv4Address(host))
        if not port.isdigit() or int(port) > 65535:
            raise ValueError
    except ValueError:
        parser.error("--listen must be <ipv4>:<port>, got %r" % args.listen)
    args.listen_port = int(port)
    try:
        args.ports = parse_ports(args.ports) if args.ports is not None else list(DEFAULT_PORTS)
    except ValueError as e:
        parser.error("--ports: %s" % e)
    return args


async def serve(args, rdir, store):
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    try:
        sock = bind_listener(args.listen_host, args.listen_port)
    except OSError as e:
        sys.exit("code-browser-proxy: cannot listen on %s: %s" % (args.listen, e.strerror or e))
    host, port = sock.getsockname()[:2]
    proxy = Proxy(rdir, args.ports, port)
    server = await asyncio.start_server(proxy.handle, sock=sock, limit=MAX_FRAME_BYTES)
    pid = os.getpid()
    write_host_json(rdir, "%s:%d" % (host, port), pid)

    def on_signal(signum, frame):
        loop.call_soon_threadsafe(stop.set)

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), on_signal)

    print("code-browser-proxy listening on %s:%d" % (host, port), flush=True)
    log("code-browser store: %s" % store)
    log("forwarding to %s port(s) %s" % (LOOPBACK_HOST, ",".join(str(p) for p in args.ports)))
    secret_file = Path(rdir) / RENDEZVOUS["backendFile"]
    if not os.path.lexists(str(secret_file)):
        log("waiting for code-browser to create %s" % secret_file)
    await stop.wait()
    log("shutting down")
    proxy.close()
    remove_host_json_if_ours(rdir, pid)
    server.close()
    await server.wait_closed()


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        route = default_route_ipv4()
    except OSError:
        route = None  # no default route: nothing to compare against
    problem = listen_problem(args.listen_host, route)
    if problem:
        sys.exit("code-browser-proxy: " + problem)
    store, searched = find_store(__file__, args.projects_root)
    if store is None:
        if args.projects_root is not None:
            sys.exit("code-browser-proxy: no %s directory in %s — start code-browser once with that projects root so it "
                     "creates one" % (STORE_RELPATH, searched[0]))
        sys.exit("code-browser-proxy: no %s found in any parent of %s (searched: %s) — start code-browser once so it "
                 "creates <projectsRoot>/%s, or pass --projects-root <dir>"
                 % (STORE_RELPATH, Path(__file__).resolve().parent, ", ".join(searched), STORE_RELPATH))
    try:
        rdir = proxy_dir(store)
        asyncio.run(serve(args, rdir, store))
    except RendezvousError as e:
        sys.exit("code-browser-proxy: %s" % e)
    except OSError as e:
        sys.exit("code-browser-proxy: %s" % e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
