import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildSnippet } from '../src/snippet.js';
import { tmpDir } from './helpers.mjs';

const opts = { pluginDir: '/opt/code browser', cdpEndpoint: 'http://127.0.0.1:9333', activeTargetId: 'T"1' };

// Invariant: the snippet is valid ESM whatever the paths and ids contain (all values are JSON-quoted).
test('the snippet parses as an ES module', () => {
  for (const activeTargetId of [opts.activeTargetId, null]) {
    const file = path.join(tmpDir(), 'snippet.mjs');
    fs.writeFileSync(file, buildSnippet({ ...opts, activeTargetId }));
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
});

// Invariant: it resolves playwright-core from the plugin dir, connects to the given endpoint, uses the shared context and only disconnects.
test('the snippet bakes in the plugin dir, endpoint and active target', () => {
  const s = buildSnippet(opts);
  assert.ok(s.includes('createRequire("/opt/code browser/package.json")'));
  assert.ok(s.includes('connectOverCDP("http://127.0.0.1:9333")'));
  assert.ok(s.includes('browser.contexts()[0]'));
  assert.ok(!s.includes('newContext'));
  assert.ok(s.includes('"T\\"1"'));
  assert.ok(!buildSnippet({ ...opts, activeTargetId: null }).includes('Target.getTargetInfo'));
});

// Invariant: in an attached browser with no active tab the snippet opens the agent's own tab instead of taking one of
// the user's; with an active tab it picks that one; and in approval mode it waits for the person's click.
test('attached snippets open their own tab and wait for approval', () => {
  const own = buildSnippet({ ...opts, activeTargetId: null, attached: true });
  assert.ok(own.includes('let page = await context.newPage();'));
  assert.ok(!own.includes('context.pages()[0]'));
  assert.ok(buildSnippet({ ...opts, attached: true }).includes('Target.getTargetInfo'));
  const approval = buildSnippet({ ...opts, cdpEndpoint: 'ws://127.0.0.1:9333/devtools/browser', attached: true, asksApproval: true, activeTargetId: null });
  assert.match(approval, /connectOverCDP\("ws:\/\/127\.0\.0\.1:9333\/devtools\/browser", \{ timeout: \d+ \}\)/);
  assert.ok(!buildSnippet(opts).includes('timeout'));
  for (const s of [own, approval]) {
    const file = path.join(tmpDir(), 'snippet.mjs');
    fs.writeFileSync(file, s);
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
});
