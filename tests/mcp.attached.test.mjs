// MCP tools over a real manager and an attached-via-proxy browser, without Python: the proxy is the in-process fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMcp } from '../src/mcp.js';
import { PROTOCOL } from '../src/proxyProtocol.js';
import { fakeProxy } from './fakes/fakeProxy.mjs';
import { externalFake, liveStack, tmpDir, waitFor } from './helpers.mjs';

// Invariant: no MCP tool result (text, meta, snippet, error) for a browser attached through the proxy contains the
// provisioned proxy secret, whether it is connected or not.
test('no tool result carries the proxy secret', async () => {
  const dataDir = path.join(tmpDir(), 'data');
  const stack = liveStack({ dataDir });
  await stack.manager.boot();
  const secret = JSON.parse(fs.readFileSync(path.join(dataDir, 'proxy', PROTOCOL.rendezvous.backendFile), 'utf8')).secret;
  const proxy = await fakeProxy(dataDir);
  const f = await externalFake();
  const mcp = createMcp({ manager: stack.manager, pluginDir: '/plug', pluginId: 'code-browser' });
  const call = (tool) => mcp.handle({ tool, arguments: { name: 'mine' } });
  try {
    await stack.manager.attach('mine', { address: f.address, via: 'proxy' });
    await waitFor(() => stack.manager.session('mine').snapshot().tabs.length === 1, { what: 'tabs through the proxy' });
    const info = await call('browser_info');
    assert.equal(info.meta.attached.via, 'proxy');
    assert.match(info.text, /connectOverCDP/);
    const results = [info, await call('list_browsers'), await call('start_browser')];
    results.push(await call('stop_browser'), await call('browser_info'), await call('list_browsers'));
    assert.match(results[2].error, /^ATTACHED/);
    assert.match(results[4].error, /^NOT_RUNNING/);
    for (const r of results) assert.ok(!JSON.stringify(r).includes(secret), JSON.stringify(r).slice(0, 200));
  } finally {
    proxy.close();
    await stack.close();
    await f.kill();
  }
});
