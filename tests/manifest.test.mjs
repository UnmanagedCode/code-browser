import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { checkSchema } from './_jsonSchemaSubset.mjs';

const manifest = JSON.parse(fs.readFileSync(new URL('../conductor.plugin.json', import.meta.url), 'utf8'));

// The key sets cc's manifest validator accepts (code-conductor docs/plugins.md); any other key makes the plugin invalid.
const TOP = ['id', 'name', 'version', 'pluginApi', 'backend', 'frontend', 'mcp', 'conventions', 'roles', 'playbooks', 'claudePlugin', 'runCodeModule', 'menuItems'];
const BACKEND = ['start', 'healthPath', 'readyWhen'];
const FRONTEND = ['path', 'navLabel', 'keepAlive'];
const MCP = ['endpoint', 'scope', 'timeoutMs', 'tools'];
const PROP = ['type', 'enum', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'items', 'description', 'default'];
const SCHEMA = ['type', 'properties', 'required', 'description', 'additionalProperties'];
const MCP_TIMEOUT_CAP = 120_000;

// Invariant: the manifest only uses keys cc accepts, so the plugin never loads as invalid.
test('manifest keys are within the sets cc accepts', () => {
  const within = (obj, allowed, where) => {
    for (const k of Object.keys(obj)) assert.ok(allowed.includes(k), `unknown key '${where}.${k}'`);
  };
  within(manifest, TOP, '');
  within(manifest.backend, BACKEND, 'backend');
  within(manifest.frontend, FRONTEND, 'frontend');
  within(manifest.mcp, MCP, 'mcp');
  assert.ok(manifest.mcp.timeoutMs <= MCP_TIMEOUT_CAP);
  assert.equal(manifest.pluginApi, 1);
  assert.ok(manifest.backend.healthPath.startsWith('/'));
  for (const tool of manifest.mcp.tools) {
    within(tool.inputSchema, SCHEMA, `${tool.name}.inputSchema`);
    assert.equal(tool.inputSchema.type, 'object');
    for (const [prop, spec] of Object.entries(tool.inputSchema.properties ?? {})) {
      within(spec, PROP, `${tool.name}.${prop}`);
    }
  }
});

// Invariant: the name pattern in the tool schemas is the one NAME_RE enforces, so schema and runtime agree.
test('tool name patterns equal NAME_RE', async () => {
  const { NAME_RE } = await import('../src/limits.js');
  for (const tool of manifest.mcp.tools) {
    for (const spec of Object.values(tool.inputSchema.properties ?? {})) {
      if (spec.pattern) assert.equal(spec.pattern, NAME_RE.source);
    }
  }
});

// Invariant: no tool can grant the unsandboxed opt-in: each takes at most a `name`, and none is named for it.
test('no tool takes anything but name or is named for the sandbox opt-in', () => {
  for (const tool of manifest.mcp.tools) {
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).filter((p) => p !== 'name'), [], tool.name);
    assert.doesNotMatch(tool.name, /allow|sandbox/);
  }
});

// Invariant: the listing explains allowUnsandboxed and attached browsers. start_browser and browser_info leave the
// sandbox refusal, the opt-in and attached browsers to the point of use (the SANDBOX_UNAVAILABLE and ATTACHED refusals,
// and `notes`; see tests/mcp.test.mjs).
test('list_browsers explains allowUnsandboxed and attached', () => {
  const desc = manifest.mcp.tools.find((t) => t.name === 'list_browsers').description;
  assert.match(desc, /allowUnsandboxed/);
  assert.match(desc, /attached/);
});

// Invariant: before its first call an agent learns both ways to drive the browser: the run_code helper through
// cc.code_browser.import() (or helper.module where that is unavailable) and the Bash snippet; and to obey `controller`.
test('start_browser and browser_info name the run_code helper and the snippet', () => {
  const desc = (name) => manifest.mcp.tools.find((t) => t.name === name).description;
  assert.ok(desc('start_browser').includes('cc.code_browser.import()'));
  assert.match(desc('start_browser'), /`snippet`/);
  assert.match(desc('browser_info'), /`helper\.module`/);
  assert.match(desc('browser_info'), /`snippet`/);
  assert.match(desc('browser_info'), /`controller`/);
});

// Invariant: no tool is named `import`: cc reserves it in every plugin namespace (cc.<ns>.import), and such a tool would
// make the manifest invalid.
test('no tool is named import', () => {
  for (const tool of manifest.mcp.tools) assert.notEqual(tool.name, 'import');
});

// Invariant: no tool attaches or connects a browser: that is a human's action in the panel only.
test('no tool is named for attaching or connecting', () => {
  for (const tool of manifest.mcp.tools) assert.doesNotMatch(tool.name, /attach|connect/, tool.name);
});

// Invariant: stop_browser tells the agent that for an attached browser it only disconnects.
test('stop_browser says it only disconnects an attached browser', () => {
  const desc = (name) => manifest.mcp.tools.find((t) => t.name === name).description;
  assert.match(desc('stop_browser'), /only disconnects/);
});

// Invariant: stop_browser's description, read at the point of use, tells the agent to stop only browsers it started and
// never while a person holds control: no other surface carries that ownership rule.
test('stop_browser says to stop only own browsers and never while a person has control', () => {
  const desc = manifest.mcp.tools.find((t) => t.name === 'stop_browser').description;
  assert.match(desc, /only stop a browser you started/i);
  assert.match(desc, /never while a person holds control/i);
});

// Invariant: the panel is called one thing everywhere it names itself: manifest name, nav label and page title.
test('the nav label and the page title equal the manifest name', () => {
  assert.equal(manifest.frontend.navLabel, manifest.name);
  const html = fs.readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
  assert.equal(html.match(/<title>([^<]*)<\/title>/)?.[1], manifest.name);
});

// ---- typed output (cc's typed plugin tools) ----
const TOOL_KEYS = ['name', 'description', 'inputSchema', 'outputSchema'];

// Invariant: every tool declares an outputSchema inside cc's validated vocabulary with an object root, and the tool
// entries use only the keys cc accepts, so cc serves each tool in json.
test('every tool has an outputSchema within cc\'s subset and an object root', () => {
  for (const tool of manifest.mcp.tools) {
    for (const k of Object.keys(tool)) assert.ok(TOOL_KEYS.includes(k), `unknown key '${tool.name}.${k}'`);
    assert.ok(tool.outputSchema, `${tool.name} has an outputSchema`);
    assert.doesNotThrow(() => checkSchema(tool.outputSchema), tool.name);
    assert.equal(tool.outputSchema.type, 'object', tool.name);
  }
});

// Invariant: the summary schema is written out twice (no $ref in cc's subset); the copies in list_browsers and
// browser_info/start_browser cannot drift apart.
test('the summary property schemas are identical wherever they are written out', () => {
  const tool = (name) => manifest.mcp.tools.find((t) => t.name === name).outputSchema;
  const item = tool('list_browsers').properties.browsers.items;
  assert.deepEqual(item.required, Object.keys(item.properties));
  for (const name of ['browser_info', 'start_browser']) {
    for (const [key, spec] of Object.entries(item.properties)) assert.deepEqual(tool(name).properties[key], spec, `${name}.${key}`);
  }
  assert.deepEqual(tool('browser_info'), tool('start_browser'));
});

// Invariant: descriptions describe data, not a rendering: none promises "returns json/text", mentions raw text or `meta`.
test('descriptions are format-neutral', () => {
  for (const tool of manifest.mcp.tools) assert.doesNotMatch(tool.description, /returns? (json|text)|raw text|\bmeta\b/i, tool.name);
});

// Invariant: runCodeModule names, in the form cc's validator accepts (a relative .js/.mjs path, no '..', no leading '/'),
// a git-tracked file whose default export is a function: the factory cc calls for cc.code_browser.import().
test('runCodeModule names a tracked module whose default export is a function', async () => {
  const rel = manifest.runCodeModule;
  assert.equal(typeof rel, 'string');
  assert.match(rel, /\.(mjs|js)$/);
  assert.ok(!rel.startsWith('/') && !rel.split(/[\\/]/).includes('..'), rel);
  const root = new URL('..', import.meta.url);
  assert.doesNotThrow(() => execFileSync('git', ['ls-files', '--error-unmatch', rel], { cwd: root, stdio: 'pipe' }), `${rel} is not tracked`);
  const mod = await import(new URL(rel, root).href);
  assert.equal(typeof mod.default, 'function');
});

// Invariant: claudePlugin names (relative, as cc's validator requires) a git-tracked Claude Code plugin root named for
// the manifest id, whose drive-browser skill has the frontmatter Claude Code reads, so cc can load it into sessions.
test('claudePlugin points at a tracked Claude Code plugin with the drive-browser skill', () => {
  const rel = manifest.claudePlugin;
  assert.equal(typeof rel, 'string');
  assert.ok(!rel.startsWith('/') && !rel.split(/[\\/]/).includes('..'), rel);
  const root = new URL('..', import.meta.url);
  const files = [`${rel}/.claude-plugin/plugin.json`, `${rel}/skills/drive-browser/SKILL.md`];
  for (const f of files) {
    assert.doesNotThrow(() => execFileSync('git', ['ls-files', '--error-unmatch', f], { cwd: root, stdio: 'pipe' }), `${f} is not tracked`);
  }
  const plugin = JSON.parse(fs.readFileSync(new URL(files[0], root), 'utf8'));
  assert.equal(plugin.name, manifest.id);
  assert.match(fs.readFileSync(new URL(files[1], root), 'utf8'), /^---\nname: drive-browser\ndescription: .+\n---\n/);
});

// Invariant: every code or constant the skill names in backticks still exists in src/, so a rename there cannot leave
// the skill teaching a refusal code or limit that no longer exists.
test('every code and constant the skill names exists in src/', () => {
  const skill = fs.readFileSync(new URL(`../${manifest.claudePlugin}/skills/drive-browser/SKILL.md`, import.meta.url), 'utf8');
  const names = [...new Set([...skill.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((m) => m[1]))];
  assert.ok(names.length > 0);
  const srcDir = new URL('../src/', import.meta.url);
  const source = fs.readdirSync(srcDir, { recursive: true })
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(new URL(f, srcDir), 'utf8'))
    .join('\n');
  for (const n of names) assert.match(source, new RegExp(`\\b${n}\\b`), `${n} is not in src/`);
});
