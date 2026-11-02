"""Unit tests for proxy/cdp_proxy.py. Standard library only; run from npm test via
tests/proxy.test.mjs, or directly: python3 -m unittest discover -s tests/python -v
"""

import ast
import asyncio
import hashlib
import hmac
import json
import os
import secrets
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
PROXY_DIR = ROOT / "proxy"
sys.path.insert(0, str(PROXY_DIR))

import cdp_proxy  # noqa: E402

PROTOCOL = json.loads((PROXY_DIR / "protocol.json").read_text(encoding="utf-8"))
FRAMES = PROTOCOL["frames"]
ERRORS = PROTOCOL["errorCodes"]
LABELS = PROTOCOL["macLabels"]
RDV = PROTOCOL["rendezvous"]
VECTOR = json.loads((ROOT / "tests" / "fixtures" / "proxy-mac-vector.json").read_text(encoding="utf-8"))
SECRET = "x" * PROTOCOL["minSecretLength"]


def ref_mac(secret, label, nonce_proxy, nonce_client, port):
    """The MAC as docs/protocol.md defines it, computed without the module under test."""
    msg = "\n".join((label, nonce_proxy, nonce_client, str(port)))
    return hmac.new(secret.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()


def write_secret(rdir, secret=SECRET):
    (Path(rdir) / RDV["backendFile"]).write_text(json.dumps({"protocolVersion": PROTOCOL["protocolVersion"], "secret": secret}))


class Source(unittest.TestCase):
    # Invariant: the proxy parses as Python 3.9, the oldest version it claims to support.
    def test_parses_as_python_3_9(self):
        ast.parse((PROXY_DIR / "cdp_proxy.py").read_text(encoding="utf-8"), feature_version=(3, 9))

    # Invariant: the MAC agrees with the shared fixture vector (the Node client checks the same vector).
    def test_mac_vector(self):
        v = VECTOR
        self.assertEqual(cdp_proxy.mac(v["secret"], LABELS["client"], v["nonceProxy"], v["nonceClient"], v["port"]), v["clientMac"])
        self.assertEqual(cdp_proxy.mac(v["secret"], LABELS["proxy"], v["nonceProxy"], v["nonceClient"], v["port"]), v["proxyMac"])
        self.assertNotEqual(v["clientMac"], v["proxyMac"], "distinct labels stop a reflected MAC")

    # Invariant: the proxy's default reach is exactly 127.0.0.1:9222; widening it means changing this literal.
    def test_default_reach_is_9222_only(self):
        self.assertEqual(PROTOCOL["defaultPorts"], [9222])
        self.assertEqual(cdp_proxy.parse_args([], default_host=lambda: "127.0.0.1").ports, [9222])

    # Invariant: without --ports the proxy forwards only to protocol.json's defaultPorts; --ports replaces that list.
    def test_default_and_replaced_ports(self):
        local = lambda: "127.0.0.1"  # noqa: E731
        self.assertEqual(cdp_proxy.parse_args([], default_host=local).ports, PROTOCOL["defaultPorts"])
        self.assertEqual(cdp_proxy.parse_args(["--ports", "9333, 9444,9333"], default_host=local).ports, [9333, 9444])
        for bad in ["", "0", "65536", "x", "9222,abc"]:
            with self.assertRaises(SystemExit, msg=bad), mock.patch("sys.stderr"):
                cdp_proxy.parse_args(["--ports", bad], default_host=local)

    # Invariant: the listener defaults to docker0 where it exists, else loopback, on defaultListenPort.
    def test_default_listen(self):
        self.assertEqual(cdp_proxy.default_listen_host(lambda: "172.17.0.1"), "172.17.0.1")
        self.assertEqual(cdp_proxy.default_listen_host(lambda: None), "127.0.0.1")
        args = cdp_proxy.parse_args([], default_host=lambda: "172.17.0.1")
        self.assertEqual((args.listen_host, args.listen_port), ("172.17.0.1", PROTOCOL["defaultListenPort"]))

    # Invariant: the listener is never put where the LAN reaches it: wildcards and the default-route address are refused.
    def test_listen_guard(self):
        self.assertIsNotNone(cdp_proxy.listen_problem("0.0.0.0", None))
        for not_ipv4 in (":7078", "[::]:7078", "localhost:7078", "127.0.0.1:99999", "127.0.0.1"):
            with self.assertRaises(SystemExit, msg=not_ipv4), mock.patch("sys.stderr"):
                cdp_proxy.parse_args(["--listen", not_ipv4])
        self.assertIsNotNone(cdp_proxy.listen_problem("192.168.1.5", "192.168.1.5"))
        self.assertIsNone(cdp_proxy.listen_problem("127.0.0.1", "127.0.0.1"))
        self.assertIsNone(cdp_proxy.listen_problem("172.17.0.1", "192.168.1.5"))
        with self.assertRaises(SystemExit) as cm:
            cdp_proxy.main(["--listen", "0.0.0.0:7078"])
        self.assertIn("wildcard", str(cm.exception.code))


class Rendezvous(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    # Invariant: the store is <ancestor>/.code-conductor/plugins/data/code-browser, found by walking up from the
    # script's own directory or taken from --projects-root.
    def test_find_store(self):
        expected = self.root / ".code-conductor" / "plugins" / "data" / "code-browser"
        expected.mkdir(parents=True)
        script = self.root / "a" / "plugin" / "proxy" / "cdp_proxy.py"
        script.parent.mkdir(parents=True)
        store, _ = cdp_proxy.find_store(script)
        self.assertEqual(store, expected.resolve())
        self.assertEqual(cdp_proxy.find_store(script, override=str(self.root))[0], expected.resolve())
        self.assertIsNone(cdp_proxy.find_store(script, override=str(self.root / "a"))[0])

    # Invariant: there is no legacy fallback: a root holding only the old .code-browser store has no store.
    def test_find_store_ignores_legacy(self):
        (self.root / ".code-browser").mkdir()
        script = self.root / "a" / "proxy" / "cdp_proxy.py"
        script.parent.mkdir(parents=True)
        self.assertIsNone(cdp_proxy.find_store(script)[0])
        self.assertIsNone(cdp_proxy.find_store(script, override=str(self.root))[0])

    # Invariant: the proxy's hardcoded store path ends in the plugin id cc names the data dir after.
    def test_store_relpath_matches_manifest_id(self):
        manifest = json.loads((ROOT / "conductor.plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(cdp_proxy.STORE_RELPATH.name, manifest["id"])

    # Invariant: a missing store exits non-zero naming the relative path the person must create or point at.
    def test_main_names_store_path(self):
        with self.assertRaises(SystemExit) as cm:
            cdp_proxy.main(["--projects-root", str(self.root), "--listen", "127.0.0.1:0"])
        self.assertIn(".code-conductor/plugins/data/code-browser", str(cm.exception.code))

    # Invariant: host.json is published atomically 0600 and removed only while it still names this pid.
    def test_host_json(self):
        path = cdp_proxy.write_host_json(self.root, "127.0.0.1:7078", 4242)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(json.loads(path.read_text()), {"protocolVersion": PROTOCOL["protocolVersion"], "listen": "127.0.0.1:7078", "pid": 4242})
        self.assertEqual([p.name for p in self.root.iterdir()], [RDV["proxyFile"]], "no tmp file is left behind")
        self.assertFalse(cdp_proxy.remove_host_json_if_ours(self.root, 1))
        self.assertTrue(path.exists())
        self.assertTrue(cdp_proxy.remove_host_json_if_ours(self.root, 4242))
        self.assertFalse(path.exists())

    # Invariant: a rendezvous file is read only when it is a small regular file; a FIFO never blocks the read.
    def test_read_small_file_refusals(self):
        fifo = self.root / "fifo"
        os.mkfifo(str(fifo))
        with self.assertRaisesRegex(ValueError, "not a regular file"):
            cdp_proxy.read_small_file(fifo)
        big = self.root / "big"
        big.write_text("x" * (PROTOCOL["maxRendezvousBytes"] + 1))
        with self.assertRaisesRegex(ValueError, "larger than"):
            cdp_proxy.read_small_file(big)

    # Invariant: a symlinked rendezvous file is never followed: the secret is refused, and host.json is not removed
    # through it.
    def test_symlinks_are_refused(self):
        target = self.root / "elsewhere.json"
        target.write_text(json.dumps({"secret": SECRET, "pid": 7}))
        (self.root / RDV["backendFile"]).symlink_to(target)
        with self.assertRaises(cdp_proxy.SecretUnavailable):
            cdp_proxy.read_secret(self.root)
        (self.root / RDV["proxyFile"]).symlink_to(target)
        self.assertFalse(cdp_proxy.remove_host_json_if_ours(self.root, 7))
        self.assertTrue(target.exists())

    # Invariant: the proxy makes its rendezvous dir 0700, tightening one that already exists.
    def test_proxy_dir_is_tightened(self):
        (self.root / RDV["dir"]).mkdir(mode=0o755)
        os.chmod(str(self.root / RDV["dir"]), 0o755)
        path = cdp_proxy.proxy_dir(self.root)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o700)

    # Invariant: a missing, malformed or short secret is reported with the path, never used.
    def test_read_secret_refusals(self):
        with self.assertRaises(cdp_proxy.SecretUnavailable):
            cdp_proxy.read_secret(self.root)
        write_secret(self.root, "short")
        with self.assertRaisesRegex(cdp_proxy.SecretUnavailable, "at least"):
            cdp_proxy.read_secret(self.root)
        write_secret(self.root)
        self.assertEqual(cdp_proxy.read_secret(self.root), SECRET)


class Wire(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.rdir = Path(self.tmp.name)
        write_secret(self.rdir)
        self.echo_conns = 0
        self.logged = []
        patcher = mock.patch.object(cdp_proxy, "log", self.logged.append)
        patcher.start()
        self.addCleanup(patcher.stop)

        async def echo(reader, writer):
            self.echo_conns += 1
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                writer.write(data)
                await writer.drain()
            writer.close()

        self.echo = await asyncio.start_server(echo, "127.0.0.1", 0)
        self.echo_port = self.echo.sockets[0].getsockname()[1]
        await self.start_proxy([self.echo_port])

    async def start_proxy(self, ports):
        self.proxy = cdp_proxy.Proxy(self.rdir, ports, 0)
        self.server = await asyncio.start_server(self.proxy.handle, "127.0.0.1", 0, limit=cdp_proxy.MAX_FRAME_BYTES)
        self.proxy_port = self.server.sockets[0].getsockname()[1]
        self.proxy.listen_port = self.proxy_port

    async def asyncTearDown(self):
        self.proxy.close()
        self.server.close()
        self.echo.close()
        await self.server.wait_closed()
        await self.echo.wait_closed()
        self.tmp.cleanup()

    async def dial(self, port, secret=SECRET, mutate=None):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.proxy_port)
        hello = json.loads(await reader.readline())
        nonce = secrets.token_urlsafe(PROTOCOL["nonceBytes"])
        frame = {"t": FRAMES["auth"], "v": PROTOCOL["protocolVersion"], "nonce": nonce, "port": port,
                 "mac": ref_mac(secret, LABELS["client"], hello["nonce"], nonce, port)}
        if mutate:
            frame = mutate(frame)
        writer.write((json.dumps(frame) + "\n").encode())
        await writer.drain()
        line = await reader.readline()
        reply = json.loads(line) if line else None
        return reader, writer, hello, nonce, reply

    async def refused(self, port, code, **kw):
        reader, writer, _, _, reply = await self.dial(port, **kw)
        writer.close()
        self.assertEqual(reply["t"], FRAMES["error"])
        self.assertEqual(reply["code"], code, reply)
        return reply

    # Invariant: an authenticated connection is spliced to 127.0.0.1:<port>, and the welcome proves the secret under the proxy label.
    async def test_good_handshake_splices(self):
        reader, writer, hello, nonce, reply = await self.dial(self.echo_port)
        self.assertEqual(hello["t"], FRAMES["hello"])
        self.assertEqual(reply, {"t": FRAMES["welcome"], "mac": ref_mac(SECRET, LABELS["proxy"], hello["nonce"], nonce, self.echo_port)})
        request = b"GET /json/version HTTP/1.1\r\n\r\n"
        writer.write(request)
        await writer.drain()
        self.assertEqual(await asyncio.wait_for(reader.readexactly(len(request)), 2), request)
        writer.close()

    # Invariant: a wrong MAC is refused with auth_failed and the proxy makes no outbound connection.
    async def test_wrong_mac(self):
        await self.refused(self.echo_port, ERRORS["authFailed"], secret="y" * PROTOCOL["minSecretLength"])
        self.assertEqual(self.echo_conns, 0)
        self.assertFalse(any(SECRET in line for line in self.logged), "the secret is never logged")

    # Invariant: a client on another protocol version is told so, and nothing is connected.
    async def test_version_mismatch(self):
        reply = await self.refused(self.echo_port, ERRORS["versionMismatch"], mutate=lambda f: {**f, "v": 99})
        self.assertIn("update the proxy/ copy", reply["message"])
        self.assertEqual(self.echo_conns, 0)

    # Invariant: auth frames of the wrong shape (extra keys, a non-int or out-of-range port, a bad nonce or MAC) are bad_frame.
    async def test_bad_frames(self):
        for mutate in (lambda f: {**f, "extra": 1}, lambda f: {**f, "port": True}, lambda f: {**f, "port": "9222"},
                       lambda f: {**f, "port": 0}, lambda f: {**f, "nonce": "short"}, lambda f: {**f, "mac": "ZZ"},
                       lambda f: {**f, "t": "nope"}):
            await self.refused(self.echo_port, ERRORS["badFrame"], mutate=mutate)
        self.assertEqual(self.echo_conns, 0)

    # Invariant: with no usable secret on disk the proxy refuses with no_secret.
    async def test_no_secret(self):
        (self.rdir / RDV["backendFile"]).unlink()
        await self.refused(self.echo_port, ERRORS["noSecret"])
        self.assertEqual(self.echo_conns, 0)

    # Invariant: by default only defaultPorts are forwarded: any other port is port_refused, naming the --ports fix.
    async def test_default_refuses_other_ports(self):
        self.proxy.ports = tuple(PROTOCOL["defaultPorts"])
        reply = await self.refused(self.echo_port, ERRORS["portRefused"])
        wanted = ",".join(str(p) for p in sorted(set(PROTOCOL["defaultPorts"]) | {self.echo_port}))
        self.assertIn("--ports %s" % wanted, reply["message"])
        self.assertEqual(self.echo_conns, 0)

    # Invariant: the proxy's own port is refused even when listed in --ports.
    async def test_own_port_refused(self):
        self.proxy.ports = (self.echo_port, self.proxy_port)
        reply = await self.refused(self.proxy_port, ERRORS["portRefused"])
        self.assertIn("own port", reply["message"])

    # Invariant: an allowed port with nothing listening is connect_failed, telling the user to turn on remote debugging.
    async def test_connect_failed(self):
        self.echo.close()
        await self.echo.wait_closed()
        reply = await self.refused(self.echo_port, ERRORS["connectFailed"])
        self.assertIn("remote debugging", reply["message"])

    # Invariant: at most maxPendingHandshakes unauthenticated connections are held; one more is cut with no hello.
    async def test_pending_cap(self):
        with mock.patch.object(cdp_proxy, "MAX_PENDING_HANDSHAKES", 2):
            held = []
            for _ in range(2):
                r, w = await asyncio.open_connection("127.0.0.1", self.proxy_port)
                await r.readline()
                held.append(w)
            r, w = await asyncio.open_connection("127.0.0.1", self.proxy_port)
            self.assertEqual(await r.read(100), b"")
            for x in held + [w]:
                x.close()

    # Invariant: a client that never authenticates is cut after the handshake deadline.
    async def test_handshake_timeout(self):
        with mock.patch.object(cdp_proxy, "HANDSHAKE_TIMEOUT_S", 0.2):
            r, w = await asyncio.open_connection("127.0.0.1", self.proxy_port)
            await r.readline()
            self.assertEqual(await asyncio.wait_for(r.read(100), 2), b"")
            w.close()


if __name__ == "__main__":
    unittest.main()
