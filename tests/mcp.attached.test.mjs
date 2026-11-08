// MCP tools over a real manager and an attached-via-proxy browser, without Python: the proxy is the in-process fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMcp } from '../src/mcp.js';
import { PROTOCOL } from '../src/proxyProtocol.js';
import { call } from './_mcpCall.mjs';
import { fakeProxy } from './fakes/fakeProxy.mjs';
import { externalFake, liveStack, tmpDir, waitFor } from './helpers.mjs';

// Invariant: no MCP tool result (text, meta, structured, snippet, error, details) for a browser attached through the proxy contains the
// provisioned proxy secret, whether it is connected or not.
test('no tool result carries the proxy secret', async () => {
  const dataDir = path.join(tmpDir(), 'data');
  const stack = liveStack({ dataDir });
  await stack.manager.boot();
  const secret = JSON.parse(fs.readFileSync(path.join(dataDir, 'proxy', PROTOCOL.rendezvous.backendFile), 'utf8')).secret;
  const proxy = await fakeProxy(dataDir);
  const f = await externalFake();
  const mcp = createMcp({ manager: stack.manager, pluginDir: '/plug', pluginId: 'code-browser' });
  try {
    await stack.manager.attach('mine', { address: f.address, via: 'proxy' });
    await waitFor(() => stack.manager.session('mine').snapshot().tabs.length === 1, { what: 'tabs through the proxy' });
    for (const format of ['text', 'json']) {
      const run = (tool) => call(mcp, tool, { name: 'mine' }, format);
      const info = await run('browser_info');
      if (format === 'text') {
        assert.equal(info.meta.attached.via, 'proxy');
        assert.match(info.text, /connectOverCDP/);
      } else {
        assert.equal(info.structured.attached.via, 'proxy');
        assert.match(info.structured.snippet, /connectOverCDP/);
      }
      const results = [info, await run('list_browsers'), await run('start_browser')];
      results.push(await run('stop_browser'), await run('browser_info'), await run('list_browsers'));
      assert.equal(results[2].code, 'ATTACHED');
      assert.equal(results[4].code, 'NOT_RUNNING');
      assert.ok(results[2].details && results[4].details, 'refusals carry details');
      for (const r of results) assert.ok(!JSON.stringify(r).includes(secret), JSON.stringify(r).slice(0, 200));
      await stack.manager.connect('mine');
      await waitFor(() => stack.manager.summary('mine').status === 'running', { what: 'reconnect' });
    }
  } finally {
    proxy.close();
    await stack.close();
    await f.kill();
  }
});
