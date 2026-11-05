// Real-dependency smoke and end-to-end test: real Chromium, real backend process, real panel in a second Chromium.
// Gated: RUN_REAL_CHROMIUM=1 npm run test:e2e   (needs a Chromium: npm run install-browser, or CODE_BROWSER_CHROMIUM)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { locateChromium } from '../src/chromium/locate.js';
import { DEFAULT_WINDOW, VIEWPORT_DEBOUNCE_MS, VIEWPORT_MAX_HEIGHT, VIEWPORT_MIN_HEIGHT } from '../src/limits.js';
import { PROTOCOL } from '../src/proxyProtocol.js';
import { pidAlive } from '../src/runState.js';
import { sleep, startProxy, storeDir, tmpDir, waitFor } from './helpers.mjs';

const root = new URL('..', import.meta.url).pathname;
const { chromium } = createRequire(path.join(root, 'package.json'))('playwright-core');

const FIXTURE_HTML = `<!doctype html><title>fixture</title>
<button id="btn" style="position:fixed;left:100px;top:100px;width:200px;height:80px" onclick="document.getElementById('count').textContent=++window.n">click me</button>
<span id="count" style="position:fixed;left:350px;top:120px">0</span>
<input id="inp" style="position:fixed;left:100px;top:300px;width:300px;height:40px">
<script>window.n = 0; if (location.search === '?second') document.title = 'second';</script>`;

// Its title is only ever set by script, after load, as a real page's often is (Chromium announces no such change).
const TABS_HTML = `<!doctype html><title>loading</title>
<script>setTimeout(() => { document.title = new URLSearchParams(location.search).get('t') ?? 'none'; }, 200);</script>`;

// A page on another origin that tries to reach the backend and CDP, and reports what happened.
const HOSTILE_HTML = `<!doctype html><title>hostile</title><pre id="result">pending</pre>
<script>
const q = new URLSearchParams(location.search);
const out = { post: 'pending', backendWs: 'pending', cdpWs: 'pending' };
const done = () => { document.getElementById('result').textContent = JSON.stringify(out); };
const probe = (key, url) => new Promise((resolve) => {
  let ws; try { ws = new WebSocket(url); } catch (e) { out[key] = 'threw'; return resolve(); }
  ws.onopen = () => { out[key] = 'OPEN'; ws.close(); resolve(); };
  ws.onerror = () => { out[key] = 'failed'; resolve(); };
  ws.onclose = () => { if (out[key] === 'pending') out[key] = 'failed'; resolve(); };
});
Promise.all([
  fetch(q.get('mcp'), { method: 'POST', mode: 'no-cors', body: JSON.stringify({ tool: 'stop_browser', arguments: { name: 'e2e' } }) })
    .then(() => { out.post = 'sent'; }, () => { out.post = 'blocked'; }),
  probe('backendWs', q.get('ws')),
  probe('cdpWs', q.get('cdp')),
]).then(() => { window.finished = true; done(); });
</script>`;

function serve(html) {
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// CODE_BROWSER_PROXY_DIAL_HOST: in a container the backend dials a loopback proxy as host.docker.internal; here the
// proxy runs beside the backend, so it is dialled on 127.0.0.1 (the documented test seam).
function startBackend(projectsRoot) {
  const proc = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PROJECTS_ROOT: projectsRoot, CONDUCTOR_PLUGIN_DATA_DIR: storeDir(projectsRoot), PORT: '0', CODE_BROWSER_PROXY_DIAL_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  return waitFor(() => /listening on 127\.0\.0\.1:(\d+)/.exec(out), { what: 'backend to listen', timeout: 10_000 }).then((m) => ({ proc, port: Number(m[1]), log: () => out }));
}

async function post(port, body, headers = { 'content-type': 'application/json' }) {
  const res = await fetch(`http://127.0.0.1:${port}/api/mcp`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const tool = async (port, name, args = {}) => (await post(port, { tool: name, arguments: args })).json;

// A Chromium the user runs themselves, outside code-browser. Resolves {proc, port} once it publishes DevToolsActivePort,
// or {proc, port: null} when it publishes none within `waitMs`.
async function launchOwnChromium(userDataDir, args, waitMs = 15_000) {
  const proc = spawn(locateChromium(), ['--headless=new', `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check', ...args, 'about:blank'], { stdio: 'ignore' });
  const file = path.join(userDataDir, 'DevToolsActivePort');
  const port = await waitFor(() => { try { return Number(fs.readFileSync(file, 'utf8').split('\n')[0]) || null; } catch { return null; } }, { what: 'DevToolsActivePort', timeout: waitMs }).catch(() => null);
  return { proc, port, kill: () => new Promise((r) => { if (proc.exitCode !== null || proc.signalCode !== null) r(); else { proc.once('exit', r); proc.kill('SIGKILL'); } }) };
}

test('real Chromium end to end', { skip: process.env.RUN_REAL_CHROMIUM !== '1' && 'set RUN_REAL_CHROMIUM=1 to run', timeout: 240_000 }, async (t) => {
  const projectsRoot = tmpDir('code-browser-e2e-');
  const dataDir = storeDir(projectsRoot);
  let backend;
  let panel;
  const fixture = await serve(FIXTURE_HTML);
  const hostile = await serve(HOSTILE_HTML);
  const tabsPage = await serve(TABS_HTML);
  const fixtureUrl = `http://127.0.0.1:${fixture.port}/`;
  const cleanup = [];

  // Runs `steps` through the snippet that browser_info hands out, exactly as an agent would.
  async function agent(steps, name = 'e2e') {
    const info = await tool(backend.port, 'browser_info', { name });
    const code = /```js\n([\s\S]*?)```/.exec(info.text)[1].replace('// … your steps …', steps);
    const file = path.join(projectsRoot, `agent-${Date.now()}.mjs`);
    fs.writeFileSync(file, code);
    // Async, not spawnSync: the fixture servers live in this process and must keep answering.
    const child = spawn(process.execPath, [file], { cwd: projectsRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const status = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(status, 0, `agent script failed:\n${stderr}`);
    return stdout.trim();
  }

  try {
    backend = await startBackend(projectsRoot);
    cleanup.push(() => backend.proc.kill('SIGKILL'));
    const port = backend.port;
    // The harness's own browser (Playwright's default headless shell), separate from the shared one under test.
    panel = await chromium.launch({ chromiumSandbox: false });
    cleanup.push(() => panel.close().catch(() => {}));
    const newPage = async () => (await panel.newContext({ viewport: { width: 1000, height: 800 } })).newPage();
    const listed = async (name = 'e2e') => (await tool(backend.port, 'list_browsers')).result.find((b) => b.name === name);
    const modeOf = (f) => fs.statSync(f).mode & 0o777;
    const settingsFile = path.join(dataDir, 'settings', 'e2e.json');
    const profileDir = path.join(dataDir, 'profiles', 'e2e');
    const procsFor = (needle) => spawnSync('pgrep', ['-af', needle], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l && !l.includes('pgrep'));

    await t.test('1. health answers', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.deepEqual(await res.json(), { ok: true });
    });

    // Where Chromium's sandbox cannot start, a start is refused until a human allows it in the panel (2, 2b).
    let refused = false;
    await t.test('2. start_browser over MCP is refused without the opt-in', async () => {
      const result = await tool(port, 'start_browser', { name: 'e2e' });
      if (!result.error?.startsWith('SANDBOX_UNAVAILABLE')) {
        assert.ok(!result.error, result.error);
        t.diagnostic('sandbox usable on this host: opt-in path not exercised');
        return;
      }
      refused = true;
      assert.ok(result.error.includes('/#plugin/code-browser/?browser=e2e'), result.error);
      assert.match(result.error, /Allow without sandbox/);
      assert.ok(!fs.existsSync(path.join(dataDir, 'run', 'e2e.json')));
      assert.deepEqual(procsFor(profileDir), [], 'a refused start must leave no Chromium behind');
      const b = await listed();
      assert.equal(b.status, 'stopped');
      assert.equal(b.allowUnsandboxed, false);
      assert.equal(b.sandboxUnavailable, true);

      const grant = (headers) => fetch(`http://127.0.0.1:${port}/api/browsers/e2e/allow-unsandboxed`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"allow":true}' });
      assert.equal((await grant({})).status, 403, 'no Origin');
      assert.equal((await grant({ origin: 'http://evil.test' })).status, 403, 'foreign Origin');
      assert.ok(!fs.existsSync(settingsFile), 'a refused grant must not write the opt-in');
    });

    await t.test('2b. a human grants it in the panel UI and starts the browser', { skip: !refused && 'sandbox usable on this host' }, async () => {
      const page = await newPage();
      await page.goto(`http://127.0.0.1:${port}/?browser=e2e`);
      await page.getByRole('heading', { name: 'Not started: no usable sandbox' }).waitFor({ timeout: 20_000 });
      await page.getByRole('button', { name: 'Allow without sandbox…' }).click();
      await page.getByRole('button', { name: 'Allow', exact: true }).click();
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await waitFor(async () => (await listed()).status === 'running', { what: 'e2e to run after the human allowed it', timeout: 20_000 });
      assert.equal(modeOf(settingsFile), 0o600);
      assert.equal(modeOf(path.dirname(settingsFile)), 0o700);
      await page.close();
    });

    let started;
    await t.test('2c. start_browser result: endpoint, panel path, snippet, loopback only, guards', async () => {
      started = await tool(port, 'start_browser', { name: 'e2e' });
      assert.ok(!started.error, started.error);
      const cdpPort = Number(new URL(started.meta.cdpEndpoint).port);
      assert.match(started.meta.cdpEndpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(started.meta.panelPath, '/#plugin/code-browser/?browser=e2e');
      assert.match(started.text, /connectOverCDP/);
      assert.equal(typeof started.meta.sandbox, 'boolean');
      if (refused) {
        assert.equal(started.meta.sandbox, false);
        assert.equal(started.meta.allowUnsandboxed, true);
        assert.equal(started.text.split('\n').filter((l) => l.startsWith('WARNING')).length, 1);
      }

      const listening = spawnSync('ss', ['-ltnH', `sport = :${cdpPort}`], { encoding: 'utf8' }).stdout;
      const locals = listening.trim().split('\n').map((line) => line.trim().split(/\s+/)[3]); // Local Address:Port column
      assert.deepEqual(locals, [`127.0.0.1:${cdpPort}`], `CDP must listen on loopback only: ${listening}`);
      const external = Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal);
      if (external) {
        const code = await new Promise((resolve) => {
          const s = net.connect({ host: external.address, port: cdpPort, timeout: 2000 });
          s.on('connect', () => { s.destroy(); resolve('connected'); });
          s.on('error', (e) => resolve(e.code));
          s.on('timeout', () => { s.destroy(); resolve('timeout'); });
        });
        assert.notEqual(code, 'connected', 'CDP reachable on a non-loopback address');
      }

      const body = { tool: 'start_browser', arguments: { name: 'e2e' } };
      assert.equal((await post(port, body, { 'content-type': 'text/plain' })).status, 415);
      assert.equal((await post(port, body, { 'content-type': 'application/json', origin: 'http://evil.test' })).status, 403);
    });

    await t.test('3. an agent script drives the page and disconnects without stopping the browser', async () => {
      await agent(`await page.goto(${JSON.stringify(fixtureUrl)});`);
      const info = await tool(port, 'browser_info', { name: 'e2e' });
      assert.equal(info.meta.status, 'running');
      assert.equal(info.meta.tabs.find((x) => x.active).url, fixtureUrl);
    });

    const panelUrl = `http://127.0.0.1:${port}/?browser=e2e`;
    let p1;
    let p2;
    const canvasInfo = (p) => p.evaluate(() => {
      const c = document.querySelector('canvas');
      const r = c.getBoundingClientRect();
      return { left: r.left, top: r.top, w: r.width, h: r.height, iw: c.width, ih: c.height, dw: Number(c.dataset.deviceWidth), dh: Number(c.dataset.deviceHeight), seq: Number(c.dataset.frameSeq) };
    });
    // Page CSS pixel -> client coordinates on the canvas, through the letterboxed image.
    const clientPoint = async (p, px, py) => {
      const c = await canvasInfo(p);
      const scale = Math.min(c.w / c.iw, c.h / c.ih);
      return { x: c.left + (c.w - c.iw * scale) / 2 + (px * c.iw / c.dw) * scale, y: c.top + (c.h - c.ih * scale) / 2 + (py * c.ih / c.dh) * scale };
    };

    await t.test('4. two panel viewers get frames; a human click and typing reach the page', async () => {
      // Separate contexts: pages in one context hide each other, and a hidden panel page pauses its view.
      p1 = await newPage();
      p2 = await newPage();
      const errors = [];
      const consoleLog = [];
      p1.on('pageerror', (e) => errors.push(e.message));
      for (const [tag, p] of [['p1', p1], ['p2', p2]]) {
        p.on('console', (m) => consoleLog.push(`${tag} ${m.type()}: ${m.text()}`));
        p.on('websocket', (ws) => {
          ws.on('framesent', (f) => consoleLog.push(`${tag} ws -> ${String(f.payload).slice(0, 100)}`));
          ws.on('framereceived', (f) => consoleLog.push(`${tag} ws <- ${typeof f.payload === 'string' ? f.payload.slice(0, 100) : `binary ${f.payload.length}`}`));
          ws.on('close', () => consoleLog.push(`${tag} ws closed`));
        });
      }
      await p1.goto(panelUrl);
      await p2.goto(panelUrl);
      for (const p of [p1, p2]) {
        await p.waitForSelector('canvas[data-frame-seq]', { timeout: 20_000 }).catch(async (e) => {
          throw new Error(`${e.message}\npanel text: ${await p.evaluate(() => document.body.innerText)}\nconsole:\n${consoleLog.join('\n')}`);
        });
      }
      const before = await canvasInfo(p1);
      await agent(`await page.evaluate(() => { document.body.append('x'); });`); // a change, so another frame follows
      await waitFor(async () => (await canvasInfo(p1)).seq > before.seq, { what: 'frame seq to increase on viewer 1', timeout: 10_000 });
      assert.deepEqual(errors, []);

      // The launched page's viewport takes the panel's shape (width fixed), so the frame fills the canvas.
      const panelShape = await canvasInfo(p1);
      const wantHeight = Math.min(VIEWPORT_MAX_HEIGHT, Math.max(VIEWPORT_MIN_HEIGHT, Math.round(DEFAULT_WINDOW.width * panelShape.h / panelShape.w)));
      const innerSize = async () => JSON.parse(await agent(`console.log(JSON.stringify(await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))));`));
      await waitFor(async () => Math.abs((await innerSize()).h - wantHeight) <= 1, { what: 'the page viewport to follow the panel', timeout: 10_000 });
      assert.equal((await innerSize()).w, DEFAULT_WINDOW.width);
      await waitFor(async () => { const c = await canvasInfo(p1); return Math.abs(c.dw / c.dh - c.w / c.h) < 0.02; }, { what: 'the frame to have the canvas aspect', timeout: 10_000 });

      await p1.getByRole('button', { name: 'Take control', exact: true }).click();
      await p1.getByText('You have control').waitFor();
      const btn = await clientPoint(p1, 200, 140);
      await p1.mouse.click(btn.x, btn.y);
      const inp = await clientPoint(p1, 250, 320);
      await p1.mouse.click(inp.x, inp.y);
      await p1.keyboard.type('hello');
      const seen = JSON.parse(await agent(`console.log(JSON.stringify({ count: await page.textContent('#count'), value: await page.inputValue('#inp') }));`));
      assert.deepEqual(seen, { count: '1', value: 'hello' });
    });

    await t.test('5. controller state is visible to the agent and returns on hand-back', async () => {
      const held = await tool(port, 'browser_info', { name: 'e2e' });
      assert.equal(held.meta.controller, 'human');
      assert.match(held.text, /human currently has control/);
      assert.equal((await tool(port, 'list_browsers')).result[0].controller, 'human');
      await p1.getByRole('button', { name: 'Hand back' }).click();
      await waitFor(async () => (await tool(port, 'browser_info', { name: 'e2e' })).meta.controller === 'agent', { what: 'controller to return to the agent' });
      await p2.getByText('Agent has control').waitFor();
    });

    await t.test('6. the panel follows a new agent tab and shows a page dialog', async () => {
      await agent(`const p2 = await context.newPage(); await p2.goto(${JSON.stringify(`${fixtureUrl}?second`)});`);
      await p1.getByRole('tab', { name: 'second', selected: true }).waitFor({ timeout: 10_000 });
      const info = await tool(port, 'browser_info', { name: 'e2e' });
      assert.ok(info.meta.tabs.find((x) => x.active).url.endsWith('?second'));

      await agent(`await page.evaluate(() => { setTimeout(() => alert('hi'), 300); });`);
      const dialog = p1.getByRole('dialog');
      await dialog.getByText('hi').waitFor({ timeout: 10_000 });
      await dialog.getByRole('button', { name: 'Take control' }).click(); // the backdrop covers the controller bar
      await dialog.getByRole('button', { name: 'OK' }).click();
      await dialog.waitFor({ state: 'detached', timeout: 10_000 });
      await p1.getByRole('button', { name: 'Hand back' }).click();
    });

    await t.test('6b. many tabs: search, windows, fresh titles, dialog source', async () => {
      const tabsUrl = (q) => `http://127.0.0.1:${tabsPage.port}/?t=${q}`;
      await agent(`for (let i = 1; i <= 30; i++) { const p = await context.newPage(); await p.goto(${JSON.stringify(tabsUrl(''))} + 'tab-' + String(i).padStart(2, '0')); }
const root = await browser.newBrowserCDPSession();
await root.send('Target.createTarget', { url: ${JSON.stringify(tabsUrl('far-window'))}, newWindow: true });
const v = await context.newPage(); await v.goto('chrome://version');`);
      const trigger = p1.getByRole('button', { name: /\d+ tabs…/ });
      const search = p1.getByRole('combobox', { name: 'Search tabs' });
      const optionLabels = () => p1.locator('.tab-option-label').allTextContents();

      // Search and pick: the option is named by the page's script-set title, which only a sweep delivers.
      await trigger.waitFor({ timeout: 10_000 });
      await trigger.click();
      await search.fill('tab-27');
      await waitFor(async () => (await optionLabels()).join() === 'tab-27', { what: 'one option titled tab-27', timeout: 15_000 });
      await p1.keyboard.press('Enter');
      await p1.getByRole('tab', { name: /tab-27/, selected: true }).waitFor({ timeout: 10_000 });
      assert.ok((await tool(port, 'browser_info', { name: 'e2e' })).meta.tabs.find((x) => x.active).url.endsWith('t=tab-27'));
      await waitFor(async () => {
        const strip = await p1.locator('.tab-strip').boundingBox();
        const tab = await p1.getByRole('tab', { name: /tab-27/ }).boundingBox();
        return tab.x >= strip.x - 1 && tab.x + tab.width <= strip.x + strip.width + 1;
      }, { what: 'the selected tab scrolled into the strip', timeout: 5000 });

      // Windows and browser pages.
      await trigger.click();
      await p1.getByRole('group', { name: /Window 2/ }).getByRole('option', { name: /far-window/ }).waitFor();
      assert.equal(await p1.getByRole('option', { name: /About Version/ }).count(), 0, 'browser pages are hidden by default');
      await p1.getByRole('checkbox', { name: /Show browser pages/ }).check();
      await p1.getByRole('option', { name: /About Version/ }).waitFor();

      // Recent: the tab just chosen is first.
      await p1.getByRole('radio', { name: 'Recent' }).check();
      assert.equal((await optionLabels())[0], 'tab-27');
      await p1.keyboard.press('Escape');

      // A dialog from a background tab names it, and Show tab selects it without taking control.
      await agent(`const target = context.pages().find((p) => p.url().endsWith('t=tab-03'));
await target.evaluate(() => { setTimeout(() => alert('from three'), 300); });`);
      const dialog = p1.getByRole('dialog', { name: 'Page dialog' });
      await dialog.getByText('from three').waitFor({ timeout: 10_000 });
      assert.match(await dialog.locator('.dialog-source').innerText(), /From tab: tab-03/);
      await p1.getByRole('tab', { name: /tab-03.*\(has open dialog\)/ }).waitFor();
      await dialog.getByRole('button', { name: 'Show tab' }).click();
      await p1.getByRole('tab', { name: /tab-03/, selected: true }).waitFor({ timeout: 10_000 });
      await dialog.getByRole('button', { name: 'Take control' }).click();
      await dialog.getByRole('button', { name: 'OK' }).click();
      await dialog.waitFor({ state: 'detached', timeout: 10_000 });
      await p1.getByRole('button', { name: 'Hand back' }).click();

      // Cleanup: later steps (restart, session restore) see the old tab set.
      await agent(`for (const p of context.pages()) if (/[?&]t=/.test(p.url()) || p.url().startsWith('chrome://')) await p.close();`);
      await waitFor(async () => (await tool(port, 'browser_info', { name: 'e2e' })).meta.tabs.every((x) => !/[?&]t=/.test(x.url) && !x.url.startsWith('chrome://')), { what: 'the extra tabs to close', timeout: 15_000 });
    });

    await t.test('7. a page inside the shared browser cannot drive the backend or CDP', async () => {
      const [cdpPort, wsPath] = fs.readFileSync(path.join(dataDir, 'profiles', 'e2e', 'DevToolsActivePort'), 'utf8').trim().split('\n');
      const params = new URLSearchParams({
        mcp: `http://127.0.0.1:${port}/api/mcp`,
        ws: `ws://127.0.0.1:${port}/api/ws`,
        cdp: `ws://127.0.0.1:${cdpPort}${wsPath}`,
      });
      const out = await agent(`await page.goto(${JSON.stringify(`http://127.0.0.1:${hostile.port}/?${params}`)});
await page.waitForFunction(() => window.finished === true, null, { timeout: 15000 });
console.log(await page.textContent('#result'));`);
      const result = JSON.parse(out);
      assert.notEqual(result.backendWs, 'OPEN', 'the panel socket accepted a foreign origin');
      assert.notEqual(result.cdpWs, 'OPEN', 'CDP accepted a foreign origin');
      assert.equal((await tool(port, 'browser_info', { name: 'e2e' })).meta.status, 'running');
      assert.equal((await tool(port, 'list_browsers')).result[0].status, 'running', 'the no-cors POST must not have stopped the browser');
    });

    await t.test('8. no orphans after the backend is killed; profile survives; REST lifecycle; session cookie survives a stop', async () => {
      const run = JSON.parse(fs.readFileSync(path.join(dataDir, 'run', 'e2e.json'), 'utf8'));
      assert.ok(pidAlive(run.chromiumPid));
      await p1.close();
      await p2.close();
      backend.proc.kill('SIGKILL');
      await waitFor(() => !pidAlive(run.chromiumPid), { what: 'chromium to die with its backend', timeout: 5000 });
      await waitFor(() => !pidAlive(run.keeperPid), { what: 'keeper to exit', timeout: 5000 });

      backend = await startBackend(projectsRoot);
      cleanup.push(() => backend.proc.kill('SIGKILL'));
      const list = (await tool(backend.port, 'list_browsers')).result;
      assert.deepEqual(list.map((b) => [b.name, b.status]), [['e2e', 'stopped']]);
      assert.equal(list[0].allowUnsandboxed, refused, 'the opt-in survives a backend restart');
      assert.ok(fs.existsSync(path.join(dataDir, 'profiles', 'e2e')));

      const rest = (method, p) => fetch(`http://127.0.0.1:${backend.port}/api/browsers/${p}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' });
      assert.equal((await rest('POST', 'e2e/start')).status, 200);
      // A session cookie (no expiry) must survive stop and start: the profile is seeded with restore_on_startup.
      await agent(`await context.addCookies([{ name: 'sess', value: '1', url: 'http://example.test/' }]);`);
      assert.equal((await rest('POST', 'e2e/stop')).status, 200);
      assert.equal((await rest('POST', 'e2e/start')).status, 200);
      assert.equal(await agent(`console.log((await context.cookies('http://example.test/')).length);`), '1');

      // Keyboard focus is visible on every kind of control in both themes: a ghost button, a tab and a text input all
      // get the 3px ring (computed box-shadow), which no variant, tab or input rule may override.
      for (const colorScheme of ['light', 'dark']) {
        const ctx = await panel.newContext({ viewport: { width: 1000, height: 800 }, colorScheme });
        const page = await ctx.newPage();
        await page.goto(`http://127.0.0.1:${backend.port}/?browser=e2e`);
        await page.getByRole('tab').first().waitFor({ timeout: 20_000 });
        await page.keyboard.press('Tab'); // enters keyboard modality; focuses the first control (a ghost button)
        const shadowOf = (locator) => locator.evaluate((el) => getComputedStyle(el).boxShadow);
        for (const [what, locator] of [
          ['ghost button', page.getByRole('button', { name: 'Back to browsers' })],
          ['tab', page.getByRole('tab').first()],
          ['text input', page.getByRole('textbox', { name: 'Address' })],
        ]) {
          await locator.evaluate((el) => el.focus());
          // box-shadow transitions for 150 ms after focus: wait for the settled value.
          await waitFor(async () => /\b3px\b/.test(await shadowOf(locator)), { what: `${what} to show the focus ring (${colorScheme})`, timeout: 3000 });
        }
        await ctx.close();
      }

      // The viewer's own Stop stops the browser and the panel then offers Start; start it again for the steps after.
      const viewer = await (await panel.newContext({ viewport: { width: 1000, height: 800 } })).newPage();
      await viewer.goto(`http://127.0.0.1:${backend.port}/?browser=e2e`);
      await viewer.getByRole('button', { name: 'Stop', exact: true }).click();
      await viewer.getByText('This browser is stopped.').waitFor({ timeout: 20_000 });
      assert.equal((await listed()).status, 'stopped');
      await viewer.close();
      assert.equal((await rest('POST', 'e2e/start')).status, 200);
    });

    await t.test('9. a human revokes in the panel (stopping the browser), then delete removes profile and opt-in', async () => {
      if (refused) {
        assert.equal((await listed()).status, 'running');
        const page = await newPage();
        await page.goto(`http://127.0.0.1:${backend.port}/`);
        await page.getByRole('button', { name: 'More actions for e2e' }).click();
        await page.getByRole('menuitem', { name: 'Disallow without sandbox' }).click();
        await page.getByRole('group', { name: 'Confirm stop and disallow' }).getByRole('button', { name: 'Stop and disallow' }).click();
        await waitFor(async () => { const b = await listed(); return b.status === 'stopped' && b.allowUnsandboxed === false; }, { what: 'revoke to stop the browser', timeout: 20_000 });
        assert.equal((await listed()).lastExit, null, 'a revoke is a deliberate stop, not a crash');
        assert.ok(!fs.existsSync(settingsFile));
        assert.match((await tool(backend.port, 'start_browser', { name: 'e2e' })).error, /^SANDBOX_UNAVAILABLE/);
        await page.close();
      }
      const rest = (method, p) => fetch(`http://127.0.0.1:${backend.port}/api/browsers/${p}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' });
      assert.equal((await rest('POST', 'e2e/stop')).status, 200);
      assert.equal((await rest('DELETE', 'e2e')).status, 200);
      assert.ok(!fs.existsSync(profileDir));
      assert.ok(!fs.existsSync(settingsFile));
    });

    // ---- 10–11: the user's own browser, attached by a human in the panel ----
    const listedIn = async (name) => (await tool(backend.port, 'list_browsers')).result.find((b) => b.name === name);
    const secretOf = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'proxy', PROTOCOL.rendezvous.backendFile), 'utf8')).secret;
    const noSandbox = refused ? ['--no-sandbox'] : [];
    // Forget through the row's menu and its inline confirmation.
    const forget = async (row, page) => {
      await row.getByRole('button', { name: /^More actions for / }).click();
      await page.getByRole('menuitem', { name: 'Forget' }).click();
      await page.getByRole('group', { name: 'Confirm forget' }).getByRole('button', { name: 'Forget' }).click();
    };

    await t.test('10. a human attaches their own Chromium through the real proxy; agents use it; only sockets close', async () => {
      const own = await launchOwnChromium(path.join(projectsRoot, 'external'), ['--remote-debugging-port=0', ...noSandbox]);
      cleanup.push(() => own.kill());
      assert.ok(own.port, 'the external Chromium published its port');
      let proxy = await startProxy({ projectsRoot, ports: [own.port] });
      cleanup.push(() => proxy.kill());
      const page = await newPage();
      await page.goto(`http://127.0.0.1:${backend.port}/`);
      await page.getByRole('button', { name: 'Attach a browser…' }).click();
      const form = page.getByRole('form', { name: 'Attach a browser' });
      await form.getByRole('textbox', { name: 'Name' }).fill('mine');
      await form.getByRole('textbox', { name: 'Debug address' }).fill(`127.0.0.1:${own.port}`);
      await form.getByRole('radio', { name: /On the Docker host/ }).check();
      await form.getByRole('button', { name: 'Attach' }).click();
      await waitFor(async () => (await listedIn('mine'))?.status === 'running', { what: 'the attached browser to run', timeout: 20_000 });
      const row = page.locator('li', { hasText: 'mine' });
      await row.getByText('attached', { exact: true }).waitFor();

      // The agent: cannot start or reconnect it; gets a tunnel endpoint without the secret; works in its own tab.
      assert.match((await tool(backend.port, 'start_browser', { name: 'mine' })).error, /^ATTACHED: /);
      const info = await tool(backend.port, 'browser_info', { name: 'mine' });
      assert.equal(info.meta.kind, 'attached');
      assert.deepEqual(info.meta.attached, { address: `127.0.0.1:${own.port}`, via: 'proxy', asksApproval: false });
      const endpoint = new URL(info.meta.cdpEndpoint);
      assert.equal(endpoint.hostname, '127.0.0.1');
      assert.notEqual(Number(endpoint.port), own.port, 'agents reach the browser through the backend tunnel');
      assert.equal(info.meta.sandbox, null);
      for (const text of [JSON.stringify(info), JSON.stringify(await tool(backend.port, 'list_browsers'))]) assert.ok(!text.includes(secretOf()));
      assert.match(info.text, /your own tab/);
      await agent(`await page.goto(${JSON.stringify(fixtureUrl)});`, 'mine');
      const shapeOf = async () => agent(`console.log(JSON.stringify(await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }))));`, 'mine');
      const attachedShape = await shapeOf();

      // The panel watches it, a human takes control and clicks, the agent sees the click and the controller.
      const viewer = await newPage();
      await viewer.goto(`http://127.0.0.1:${backend.port}/?browser=mine`);
      await viewer.waitForSelector('canvas[data-frame-seq]', { timeout: 20_000 });
      // The page's real <title>, committed after load, reaches the panel (Chromium sends no event for it).
      await viewer.getByRole('tab', { name: /fixture/ }).waitFor({ timeout: 10_000 });
      // A user's own browser is never resized, whatever shape the panel takes.
      await viewer.setViewportSize({ width: 700, height: 900 });
      await sleep(VIEWPORT_DEBOUNCE_MS + 400);
      await viewer.setViewportSize({ width: 1100, height: 500 });
      await sleep(VIEWPORT_DEBOUNCE_MS + 400);
      assert.equal(await shapeOf(), attachedShape, 'an attached browser keeps its own viewport');
      await viewer.getByRole('button', { name: 'Take control', exact: true }).click();
      await viewer.getByText('You have control').waitFor();
      const btn = await clientPoint(viewer, 200, 140);
      await viewer.mouse.click(btn.x, btn.y);
      assert.equal((await tool(backend.port, 'browser_info', { name: 'mine' })).meta.controller, 'human');
      assert.equal(await agent(`console.log(await page.textContent('#count'));`, 'mine'), '1');
      await viewer.getByRole('button', { name: 'Hand back' }).click();
      await viewer.close();

      // stop_browser only disconnects: Chromium and every tab (the agent's included) are still there.
      assert.deepEqual((await tool(backend.port, 'stop_browser', { name: 'mine' })).result, { name: 'mine', status: 'stopped' });
      assert.ok(pidAlive(own.proc.pid));
      const tabs = await (await fetch(`http://127.0.0.1:${own.port}/json/list`)).json();
      assert.ok(tabs.some((x) => x.url === fixtureUrl), 'the tabs are untouched');
      await row.getByRole('button', { name: 'Connect' }).click();
      await waitFor(async () => (await listedIn('mine')).status === 'running', { what: 'Connect to reconnect', timeout: 20_000 });

      // Losing the proxy is a disconnect; with the proxy back, Connect works again.
      await proxy.kill();
      await waitFor(async () => { const b = await listedIn('mine'); return b.status === 'stopped' && b.lastExit; }, { what: 'Disconnected', timeout: 10_000 });
      await row.getByText('Disconnected').waitFor();
      proxy = await startProxy({ projectsRoot, ports: [own.port] });
      cleanup.push(() => proxy.kill());
      await row.getByRole('button', { name: 'Connect' }).click();
      await waitFor(async () => (await listedIn('mine')).status === 'running', { what: 'Connect after the proxy came back', timeout: 20_000 });

      // Forget removes the record only.
      await forget(row, page);
      await waitFor(async () => !(await listedIn('mine')), { what: 'the record to go', timeout: 10_000 });
      assert.ok(!fs.existsSync(path.join(dataDir, 'attached', 'mine.json')));
      await sleep(200);
      assert.ok(pidAlive(own.proc.pid), 'forgetting never closes the browser');
      await page.close();
    });

    await t.test('11. best effort: Chrome approval mode is discovered by its empty 404; its connect is held (then cancelled) or refused', async () => {
      const dir = path.join(projectsRoot, 'approval');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ devtools: { remote_debugging: { 'user-enabled': true } } }));
      const own = await launchOwnChromium(dir, noSandbox, 8000);
      cleanup.push(() => own.kill());
      if (!own.port) {
        const version = spawnSync(locateChromium(), ['--version'], { encoding: 'utf8' }).stdout.trim();
        t.diagnostic(`${version} published no DevToolsActivePort from the remote-debugging pref: approval mode not exercised`);
        return;
      }
      const res = await fetch(`http://127.0.0.1:${own.port}/json/version`);
      assert.equal(res.status, 404);
      assert.equal(await res.text(), '');
      const page = await newPage();
      await page.goto(`http://127.0.0.1:${backend.port}/`);
      await page.getByRole('button', { name: 'Attach a browser…' }).click();
      const form = page.getByRole('form', { name: 'Attach a browser' });
      await form.getByRole('textbox', { name: 'Name' }).fill('approval');
      await form.getByRole('textbox', { name: 'Debug address' }).fill(`127.0.0.1:${own.port}`);
      await form.getByRole('radio', { name: /On this machine/ }).check();
      await form.getByRole('button', { name: 'Attach' }).click();
      const settled = await waitFor(async () => { const b = await listedIn('approval'); return b && b.status !== 'connecting' && b; }, { what: 'the approval connect to settle', timeout: 15_000 }).catch(() => null);
      if (settled) {
        assert.equal(settled.status, 'stopped');
        assert.match(settled.attachError, /refused|Allow remote debugging/);
        assert.equal(settled.attached.asksApproval, true);
      }
      const row = page.locator('li', { hasText: 'approval' });
      if (!settled) {
        t.diagnostic('Chrome held the connection for its approval dialog: refusal not observed; disconnecting');
        const b = await listedIn('approval');
        assert.equal(b.status, 'connecting');
        assert.equal(b.attached.asksApproval, true);
        await row.getByText(/click Allow/).waitFor();
        await row.getByText('asks approval').waitFor();
      }
      if (!settled) {
        await row.getByRole('button', { name: 'More actions for approval' }).click();
        await page.getByRole('menuitem', { name: 'Disconnect' }).click();
      }
      await forget(row, page);
      await waitFor(async () => !(await listedIn('approval')), { what: 'the record to go', timeout: 10_000 });
      await page.close();
    });
  } finally {
    for (const fn of cleanup.reverse()) await fn();
    fixture.server.close();
    hostile.server.close();
    tabsPage.server.close();
    await sleep(500);
    const leftovers = spawnSync('pgrep', ['-af', projectsRoot], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l && !l.includes('pgrep'));
    assert.deepEqual(leftovers, [], 'processes left running for this data dir');
  }
});
