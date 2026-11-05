// Layout and keyboard test of the built panel in real Chromium, against a fake WebSocket backend.
// Gated: RUN_REAL_CHROMIUM=1 npm run test:e2e   (needs a Chromium: npm run install-browser)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import { build } from 'vite';
import { tmpDir, waitFor } from './helpers.mjs';

const root = new URL('..', import.meta.url).pathname;
const { chromium } = createRequire(path.join(root, 'package.json'))('playwright-core');

const NAME = 'attached-browser-name-xx-27'; // 27 characters: the longest a toolbar has to hold
const longTab = (i, windowId) => ({ targetId: `T${i}`, windowId, url: `https://example.test/${'path/'.repeat(8)}${i}`, title: `A rather long page title number ${i} that never fits a tab` });
const TABS = Array.from({ length: 12 }, (_, i) => longTab(i + 1, i < 6 ? 1 : 2));
const summary = (over) => ({ name: 'x', kind: 'launched', status: 'running', controller: 'human', sandbox: true, allowUnsandboxed: false, sandboxUnavailable: false, lastExit: null, attached: null, attachError: null, ...over });
const BROWSERS = [
  summary({ name: NAME, kind: 'attached', attached: { address: '127.0.0.1:9222', via: 'proxy', asksApproval: true } }),
  summary({ name: 'unsandboxed-launch', status: 'stopped', allowUnsandboxed: true, lastExit: { code: null, signal: 'SIGSEGV', at: 1 } }),
  summary({ name: 'mine', kind: 'attached', status: 'stopped', sandbox: null, attached: { address: 'host.docker.internal:9222', via: 'proxy', asksApproval: true }, attachError: 'Chrome did not answer: the remote debugging prompt was not allowed in time, so nothing was attached' }),
];
const STATE = { type: 'state', name: NAME, status: 'running', sandbox: true, controller: { kind: 'human', you: true }, tabs: TABS, activeTabId: 'T1', recentTabIds: [], canGoBack: true, canGoForward: false };

// Serves the built panel and speaks just enough of the panel protocol; records what the panel sends.
async function startFake(dist) {
  const server = http.createServer((req, res) => {
    const file = path.join(dist, req.url === '/' || req.url.startsWith('/?') ? 'index.html' : req.url.split('?')[0]);
    if (!file.startsWith(dist) || !fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] ?? 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  const wss = new WebSocketServer({ noServer: true });
  const received = [];
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws)));
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const m = JSON.parse(String(data));
      received.push(m);
      if (m.msg === 'hello') ws.send(JSON.stringify({ type: 'browsers', list: BROWSERS }));
      if (m.msg === 'view' && m.name) ws.send(JSON.stringify(STATE));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    received,
    push: (msg) => wss.clients.forEach((c) => c.send(JSON.stringify(msg))),
    close: () => { wss.clients.forEach((c) => c.terminate()); server.close(); },
  };
}

test('panel layout and keyboard in real Chromium', { skip: process.env.RUN_REAL_CHROMIUM !== '1' && 'set RUN_REAL_CHROMIUM=1 to run', timeout: 120_000 }, async (t) => {
  const dist = tmpDir('code-browser-layout-');
  await build({ configFile: path.join(root, 'frontend/vite.config.ts'), logLevel: 'silent', build: { outDir: dist, emptyOutDir: true } });
  const fake = await startFake(dist);
  const browser = await chromium.launch({ chromiumSandbox: false });
  const viewerUrl = `http://127.0.0.1:${fake.port}/?browser=${NAME}`;
  const open = async (url, viewport, ctxOptions = {}) => {
    const ctx = await browser.newContext({ viewport, ...ctxOptions });
    const page = await ctx.newPage();
    await page.goto(url);
    return page;
  };
  t.after(async () => { await browser.close(); fake.close(); fs.rmSync(dist, { recursive: true, force: true }); });

  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const boxes = (page, selector) => page.$$eval(selector, (els) => els
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => { const r = el.getBoundingClientRect(); return { label: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 20), left: r.left, right: r.right, top: r.top, mid: r.top + r.height / 2, width: r.width }; }));

  for (const width of [390, 420]) {
    await t.test(`1. viewer at ${width}px (touch): nothing clipped, address and name keep room`, async () => {
      const page = await open(viewerUrl, { width, height: 800 }, { hasTouch: true });
      await page.getByRole('textbox', { name: 'Address' }).waitFor();
      assert.ok((await overflow(page)) <= 0, 'no horizontal scroll');
      for (const b of await boxes(page, 'header button, header input')) {
        assert.ok(b.left >= 0 && b.right <= width + 0.5, `${b.label} lies within the viewport (${b.left}..${b.right})`);
      }
      assert.ok((await page.getByRole('heading', { level: 1 }).boundingBox()).width >= 40, 'the browser name keeps room');
      assert.ok((await page.getByRole('textbox', { name: 'Address' }).boundingBox()).width >= 96, 'the address keeps room');
      assert.ok(await page.getByRole('button', { name: 'Keyboard' }).isVisible());
      assert.ok(await page.getByRole('button', { name: 'Disconnect' }).isVisible());
      await page.context().close();
    });
  }

  await t.test('2. viewer at 1000px (mouse): one toolbar row', async () => {
    const page = await open(viewerUrl, { width: 1000, height: 800 });
    await page.getByRole('textbox', { name: 'Address' }).waitFor();
    const tops = (await boxes(page, 'header button, header input, header h1')).map((b) => b.mid);
    assert.ok(tops.length >= 6);
    assert.ok(Math.max(...tops) - Math.min(...tops) <= 2, `controls share a row (centres ${tops.join(', ')})`);
    await page.context().close();
  });

  await t.test('3. list at 390px: nothing ellipsized or pushed off, buttons beside the name', async () => {
    const page = await open(`http://127.0.0.1:${fake.port}/`, { width: 390, height: 800 });
    await page.getByRole('button', { name: `Open ${NAME}` }).waitFor();
    assert.ok((await overflow(page)) <= 0, 'no horizontal scroll');
    const cut = await page.$$eval('.row-status', (els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));
    assert.deepEqual(cut, []);
    const rows = await page.$$eval('.browser-row', (els) => els.map((li) => {
      const top = (sel) => li.querySelector(sel).getBoundingClientRect();
      const main = top('.row-main');
      const primary = top(':scope > button');
      const menu = top('.row-menu button');
      return { mainTop: main.top, primaryTop: primary.top, primaryRight: primary.right, menuTop: menu.top, menuRight: menu.right, mainBottom: main.bottom };
    }));
    for (const r of rows) {
      assert.ok(r.primaryRight <= 390 && r.menuRight <= 390, 'buttons lie within the viewport');
      assert.ok(r.primaryTop < r.mainBottom && r.menuTop < r.mainBottom, 'buttons share a line with the name block');
    }
    await page.context().close();
  });

  await t.test('4. switcher and page dialog at 390px lie within the viewport', async () => {
    const page = await open(viewerUrl, { width: 390, height: 800 }, { hasTouch: true });
    await page.getByRole('textbox', { name: 'Address' }).waitFor();
    await page.getByRole('button', { name: /Search \d+ tabs/ }).click();
    const switcher = await page.getByRole('dialog', { name: 'Search tabs' }).boundingBox();
    assert.ok(switcher.x >= 0 && switcher.x + switcher.width <= 390 + 0.5, 'switcher fits');
    await page.keyboard.press('Escape');
    fake.push({ type: 'dialog', tabId: 'T1', dialogType: 'prompt', message: 'A long message '.repeat(12), defaultPrompt: 'x' });
    const dialog = await page.getByRole('dialog', { name: 'Page dialog' }).boundingBox();
    assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= 390 + 0.5, 'dialog fits');
    fake.push({ type: 'dialogClosed', tabId: 'T1' });
    await page.context().close();
  });

  await t.test('5. keyboard walk: × is skipped, one tab stop, Delete closes the focused tab', async () => {
    const page = await open(viewerUrl, { width: 1000, height: 800 });
    await page.getByRole('textbox', { name: 'Address' }).waitFor();
    await page.getByRole('heading', { level: 1 }).evaluate((h) => h.focus());
    const stops = [];
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      stops.push(await page.evaluate(() => {
        const a = document.activeElement;
        return { role: a.getAttribute('role'), hidden: a.closest('[aria-hidden="true"]') !== null, close: a.classList.contains('tab-close') };
      }));
    }
    assert.ok(stops.every((s) => !s.hidden && !s.close), 'focus never lands on ×');
    assert.equal(stops.filter((s) => s.role === 'tab').length, 1);
    await page.getByRole('tab').first().focus();
    await page.keyboard.press('ArrowRight');
    const before = fake.received.length;
    await page.keyboard.press('Delete');
    await waitFor(() => fake.received.slice(before).some((m) => m.msg === 'tab' && m.action === 'close' && m.tabId === 'T2'), { what: 'close of the focused tab' });
    await page.context().close();
  });
});
