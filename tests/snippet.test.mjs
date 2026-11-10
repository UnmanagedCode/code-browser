import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginDir } from '../src/config.js';
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

// Invariant: it resolves playwright-core from the plugin dir, connects to the given endpoint, uses the shared context,
// hands pickPage the active target, and only disconnects.
test('the snippet bakes in the plugin dir, endpoint and active target', () => {
  const s = buildSnippet(opts);
  assert.ok(s.includes('createRequire("/opt/code browser/package.json")'));
  assert.ok(s.includes('connectOverCDP("http://127.0.0.1:9333")'));
  assert.ok(s.includes('browser.contexts()[0]'));
  assert.ok(!s.includes('newContext'));
  assert.ok(s.includes('pickPage(context, { activeTargetId: "T\\"1", kind: "launched" })'));
  assert.ok(buildSnippet({ ...opts, activeTargetId: null }).includes('activeTargetId: null'));
  assert.ok(s.includes('await browser.close();'));
});

// Invariant: the snippet picks its page with the run_code helper's own rule: it imports pickPage from the helper's
// file, by a URL that names that file even when the plugin dir has spaces.
test('the snippet imports the helper\'s pickPage by file URL', () => {
  const s = buildSnippet({ ...opts, pluginDir: pluginDir });
  const url = /import \{ pickPage \} from "([^"]+)";/.exec(s)?.[1];
  assert.ok(url?.startsWith('file:'), s);
  assert.equal(fileURLToPath(url), fileURLToPath(new URL('../src/runCode/pickPage.js', import.meta.url)));
  const spaced = /from "([^"]+pickPage\.js)"/.exec(buildSnippet(opts))[1];
  assert.equal(fileURLToPath(spaced), '/opt/code browser/src/runCode/pickPage.js');
});

// Invariant: an attached browser's snippet tells pickPage so (its own tab rather than one of the user's), and in approval
// mode it waits for the person's click; elsewhere it sets no timeout.
test('attached snippets say attached and wait for approval', () => {
  const own = buildSnippet({ ...opts, activeTargetId: null, attached: true });
  assert.ok(own.includes('kind: "attached"'));
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
