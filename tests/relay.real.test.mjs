// The CDP relay against real Chromium: Playwright clients through api/relay/<name>, the panel beside them, clients
// that end cleanly and ones that are SIGKILLed, and the controller gate end to end.
// Gated: RUN_REAL_CHROMIUM=1 npm run test:e2e   (needs a Chromium: npm run install-browser, or CODE_BROWSER_CHROMIUM)
//
// The stack runs in this process (real manager, session, gateway, relay and app over real Chromium) so the relay's
// unknown-session counter is observable. The data dir is a fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { createBrowserManager } from '../src/browserManager.js';
import { createSessionForEntry } from '../src/browserSession.js';
import { createCdpRelay, relayUrl } from '../src/cdpRelay.js';
import { ensureRelayToken } from '../src/relayToken.js';
import { createViewerGateway } from '../src/viewerGateway.js';
import { decodeFrame, idleInstaller, listen, tmpDir, waitFor, within } from './helpers.mjs';

const root = new URL('..', import.meta.url).pathname;
const { chromium } = createRequire(path.join(root, 'package.json'))('playwright-core');
const NAME = 'relay';

// A page that keeps painting, so the screencast keeps sending frames, with a button that counts clicks.
const PAGE_HTML = `<!doctype html><title>relay fixture</title>
<button id="btn" style="position:fixed;left:50px;top:50px;width:200px;height:60px" onclick="this.textContent = ++window.n">0</button>
<div id="tick" style="position:fixed;left:50px;top:150px"></div>
<script>window.n = 0; let i = 0; setInterval(() => { document.getElementById('tick').textContent = ++i; }, 40);</script>`;

function serve(html) {
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

// A relay client in its own process, as an agent's program runs: it hijacks every request and adds an init script,
// prints READY, then either disconnects when its stdin ends (`close`) or waits to be killed (`hold`).
const CHILD_CLIENT = (relay, token, mode) => `
import { createRequire } from 'node:module';
import { once } from 'node:events';
const { chromium } = createRequire(${JSON.stringify(path.join(root, 'package.json'))})('playwright-core');
const browser = await chromium.connectOverCDP(${JSON.stringify(relay)}, { headers: { authorization: 'Bearer ${token}' } });
const context = browser.contexts()[0];
await context.addInitScript(() => { window.__fromA = true; });
await context.route('**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>hijacked</title>HIJACKED' }));
console.log('READY');
if (${JSON.stringify(mode)} === 'close') { process.stdin.resume(); await once(process.stdin, 'end'); await browser.close(); console.log('CLOSED'); }
else setInterval(() => {}, 1000);
`;

test('CDP relay on real Chromium', { skip: process.env.RUN_REAL_CHROMIUM !== '1' && 'set RUN_REAL_CHROMIUM=1 to run', timeout: 180_000 }, async (t) => {
  const dataDir = tmpDir('code-browser-relay-');
  const page = await serve(PAGE_HTML);
  const cleanup = [() => page.server.close()];
  const manager = createBrowserManager({ dataDir, log: { warn() {}, error() {} } , createSession: (entry) => createSessionForEntry(entry, { log: { warn() {} } }) });
  await manager.boot();
  const token = ensureRelayToken(dataDir);
  const gateway = createViewerGateway({ manager, log: { error() {} } });
  const relay = createCdpRelay({ manager, token, log: { error() {} } });
  const server = createApp({ manager, mcp: { handle: async () => ({}) }, installer: idleInstaller, distDir: path.join(dataDir, 'dist'), onUpgrade: gateway.handleUpgrade, onRelayUpgrade: relay.handleUpgrade });
  const port = await listen(server);
  cleanup.push(async () => { relay.close(); gateway.close(); server.close(); await manager.shutdown(); });
  const url = relayUrl(port, NAME);
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const connect = () => chromium.connectOverCDP(url, auth);

  // The panel, as the gateway sees it: views the browser, acks every frame.
  async function viewer(viewerId) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
    const v = { ws, frames: 0, messages: [] };
    ws.on('message', (d, isBinary) => {
      if (isBinary) { decodeFrame(d); v.frames += 1; ws.send(JSON.stringify({ msg: 'ack' })); } else v.messages.push(JSON.parse(d.toString()));
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    v.send = (m) => ws.send(JSON.stringify(m));
    v.state = () => v.messages.filter((m) => m.type === 'state').at(-1);
    v.send({ msg: 'hello', viewerId });
    v.send({ msg: 'view', name: NAME, maxWidth: 800, maxHeight: 600 });
    cleanup.push(() => ws.terminate());
    return v;
  }

  async function childClient(mode) {
    const file = path.join(dataDir, `client-${mode}-${Date.now()}.mjs`);
    fs.writeFileSync(file, CHILD_CLIENT(url, token, mode));
    const proc = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'pipe'] });
    cleanup.push(() => proc.kill('SIGKILL'));
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    await waitFor(() => out.includes('READY') || proc.exitCode !== null, { what: `client ${mode} to be ready`, timeout: 30_000 });
    assert.ok(out.includes('READY'), out);
    return { proc, out: () => out, exited: new Promise((r) => (proc.exitCode !== null || proc.signalCode !== null ? r() : proc.once('exit', r))) };
  }

  try {
    manager.ensure(NAME);
    try { await manager.start(NAME); } catch (err) {
      if (err.code !== 'SANDBOX_UNAVAILABLE') throw err;
      // The fixture's stand-in for a person's "Allow without sandbox" in the panel.
      t.diagnostic('no usable sandbox here: the fixture browser runs unsandboxed');
      await manager.setAllowUnsandboxed(NAME, true);
      await manager.start(NAME);
    }
    const session = manager.session(NAME);
    await waitFor(() => session.info().activeTargetId, { what: 'the first tab', timeout: 10_000 });
    const firstTab = session.info().activeTargetId;
    const v = await viewer('viewer-relay-abcdefgh');
    await waitFor(() => v.frames > 0, { what: 'a first frame', timeout: 10_000 });

    let a;
    let b;
    await t.test('two Playwright clients each see the existing tab and can drive it', async () => {
      [a, b] = await Promise.all([connect(), connect()]);
      for (const [label, br] of [['A', a], ['B', b]]) {
        const pages = br.contexts()[0].pages();
        assert.equal(pages.length, 1, `${label} sees the existing tab`);
      }
      const pa = a.contexts()[0].pages()[0];
      const pb = b.contexts()[0].pages()[0];
      await pa.goto(page.url);
      assert.equal(await pb.evaluate(() => document.title), 'relay fixture', 'B sees what A navigated to');
      await pb.click('#btn');
      await pa.click('#btn');
      assert.equal(await pa.evaluate(() => window.n), 2);
      await pb.goto(`${page.url}?b`);
      assert.equal(await pa.evaluate(() => location.search), '?b');
      assert.equal(relay.stats().clients, 2);
      assert.equal(relay.stats().unknownDropped, 0, 'no event arrived for a session nobody owns');
    });

    await t.test('the panel keeps working while both are connected', async () => {
      const before = v.frames;
      await waitFor(() => v.frames >= before + 5, { what: 'frames to keep arriving', timeout: 10_000 });
      const created = await a.contexts()[0].newPage();
      const s = await created.context().newCDPSession(created);
      const { targetInfo } = await s.send('Target.getTargetInfo');
      await s.detach();
      await waitFor(() => v.state()?.tabs?.some((tab) => tab.targetId === targetInfo.targetId), { what: "A's tab in the panel state", timeout: 10_000 });
      await created.close();
      await waitFor(() => !v.state().tabs.some((tab) => tab.targetId === targetInfo.targetId), { what: "A's tab to leave the panel state" });
      assert.equal(relay.stats().unknownDropped, 0);
    });

    await t.test('a client that ends leaves nothing behind (browser.close and SIGKILL)', async () => {
      await a.close();
      await waitFor(() => relay.stats().clients === 1, { what: 'A to leave' });
      for (const mode of ['close', 'hold']) {
        const child = await childClient(mode);
        // While the child lives its interception is real: B's navigation is hijacked.
        const pb = b.contexts()[0].pages()[0];
        await pb.goto(`${page.url}?while-${mode}`);
        assert.equal(await pb.evaluate(() => document.body.textContent), 'HIJACKED', `the ${mode} child intercepts while it lives`);
        if (mode === 'hold') child.proc.kill('SIGKILL'); else child.proc.stdin.end();
        await child.exited;
        if (mode === 'close') assert.ok(child.out().includes('CLOSED'), child.out());
        await waitFor(() => relay.stats().clients === 1, { what: `the ${mode} child to leave the relay` });
        await pb.goto(`${page.url}?after-${mode}`);
        assert.equal(await pb.evaluate(() => document.title), 'relay fixture', `(b) no interception left after ${mode}`);
        assert.equal(await pb.evaluate(() => window.__fromA), undefined, `(b) no init script left after ${mode}`);
        // (c) a tab created now loads instead of waiting on the dead client's waitForDebuggerOnStart.
        const fresh = await b.contexts()[0].newPage();
        await within(fresh.goto(`${page.url}?fresh-${mode}`), 15_000, `a new tab after ${mode}`);
        assert.equal(await fresh.title(), 'relay fixture');
        await fresh.close();
      }
      assert.equal(relay.stats().unknownDropped, 0);
    });

    await t.test('Browser.close through the relay is refused; Chromium outlives every client', async () => {
      const raw = new WebSocket(url, auth);
      await new Promise((resolve, reject) => { raw.once('open', resolve); raw.once('error', reject); });
      const reply = new Promise((resolve) => raw.once('message', (d) => resolve(JSON.parse(d.toString()))));
      raw.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      const r = await reply;
      assert.equal(r.id, 1);
      assert.ok(r.error, 'Browser.close is answered with an error');
      raw.close();
      await b.close();
      await waitFor(() => relay.stats().clients === 0, { what: 'every client to leave' });
      const { cdpEndpoint } = manager.summary(NAME);
      const version = await (await fetch(`${cdpEndpoint}/json/version`)).json();
      assert.ok(version.Browser, 'Chromium still answers /json/version');
      assert.equal(manager.summary(NAME).status, 'running');
    });

    await t.test('a tab the panel opens after every client left loads', async () => {
      v.send({ msg: 'control', action: 'take' });
      await waitFor(() => v.state()?.controller?.you, { what: 'control' });
      const before = new Set(v.state().tabs.map((tab) => tab.targetId));
      v.send({ msg: 'tab', action: 'new' });
      const opened = await waitFor(() => v.state()?.tabs.find((tab) => !before.has(tab.targetId)), { what: 'the panel tab', timeout: 10_000 });
      v.send({ msg: 'tab', action: 'activate', tabId: opened.targetId });
      await waitFor(() => v.state()?.activeTabId === opened.targetId, { what: 'the panel tab to be active' });
      v.send({ msg: 'nav', action: 'goto', url: `${page.url}?panel` });
      await waitFor(() => v.state()?.tabs.find((tab) => tab.targetId === opened.targetId)?.title === 'relay fixture', { what: 'the panel tab to load', timeout: 15_000 });
      v.send({ msg: 'control', action: 'release' });
      await waitFor(() => v.state()?.controller?.kind === 'agent', { what: 'release' });
    });

    // Through the relay a client's answers and events must keep Chromium's order, or Playwright drops the execution
    // context of a page that was already loaded when it attached (the panel's tab here) and evaluate never settles.
    await t.test('a new client can evaluate on every tab, including one the panel loaded', async () => {
      const c = await connect();
      const pages = c.contexts()[0].pages();
      assert.ok(pages.length >= 2);
      for (const p of pages) assert.equal(await within(p.evaluate(() => document.readyState), 5000, `evaluate on ${p.url()}`), 'complete');
      await c.close();
    });

    await t.test('controller gate: refused while a person holds control, dropped on take, back after release', async () => {
      v.send({ msg: 'control', action: 'take' });
      await waitFor(() => v.state()?.controller?.you, { what: 'control' });
      await assert.rejects(connect(), (err) => /BROWSER_CONTROLLED/.test(err.message), 'a connect is refused while a person holds control');
      v.send({ msg: 'control', action: 'release' });
      await waitFor(() => v.state()?.controller?.kind === 'agent', { what: 'release' });

      const c = await connect();
      const pc = c.contexts()[0].pages()[0];
      const inFlight = pc.evaluate(() => new Promise((r) => setTimeout(r, 10_000)));
      inFlight.catch(() => {});
      await new Promise((r) => setTimeout(r, 200));
      v.send({ msg: 'control', action: 'take' });
      await assert.rejects(within(inFlight, 5000, 'the in-flight evaluate'), (err) => /BROWSER_CONTROLLED/.test(err.message), 'the in-flight command fails naming the controller');
      await waitFor(() => relay.stats().clients === 0, { what: 'the client to be dropped' });
      v.send({ msg: 'control', action: 'release' });
      await waitFor(() => v.state()?.controller?.kind === 'agent', { what: 'release' });
      const again = await connect();
      assert.equal(again.contexts()[0].pages().length > 0, true, 'a new connect after release works');
      await again.close();
      await c.close().catch(() => {});
    });
  } finally {
    for (const fn of cleanup.reverse()) await fn();
  }
});
