import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync(new URL('../conductor.plugin.json', import.meta.url), 'utf8'));

// The key sets cc's manifest validator accepts (code-conductor docs/plugins.md); any other key makes the plugin invalid.
const TOP = ['id', 'name', 'version', 'pluginApi', 'backend', 'frontend', 'mcp', 'conventions', 'roles', 'playbooks', 'claudePlugin', 'menuItems'];
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

// Invariant: the tools that start or describe a browser tell the agent about the refusal, that only a human can lift it
// in the panel, and to check `sandbox`.
test('descriptions explain the sandbox refusal and the human opt-in', () => {
  const desc = (name) => manifest.mcp.tools.find((t) => t.name === name).description;
  assert.match(desc('start_browser'), /SANDBOX_UNAVAILABLE/);
  assert.match(desc('start_browser'), /human/);
  assert.match(desc('start_browser'), /panel/);
  assert.match(desc('start_browser'), /`sandbox`/);
  assert.match(desc('browser_info'), /`sandbox`/);
  for (const name of ['browser_info', 'list_browsers']) assert.match(desc(name), /allowUnsandboxed/, name);
});

// Invariant: no tool attaches or connects a browser: that is a human's action in the panel only.
test('no tool is named for attaching or connecting', () => {
  for (const tool of manifest.mcp.tools) assert.doesNotMatch(tool.name, /attach|connect/, tool.name);
});

// Invariant: the tools tell the agent that an attached browser is the user's: start refuses it (ATTACHED), stop only
// disconnects, and the listing and info explain kind and attached.
test('descriptions explain attached browsers', () => {
  const desc = (name) => manifest.mcp.tools.find((t) => t.name === name).description;
  assert.match(desc('start_browser'), /ATTACHED/);
  assert.match(desc('start_browser'), /Connect/);
  assert.match(desc('stop_browser'), /only disconnects/);
  for (const name of ['list_browsers', 'browser_info']) assert.match(desc(name), /attached/, name);
  assert.match(desc('browser_info'), /asksApproval/);
});
