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

// Invariant: the two tools that start or describe a browser tell the agent it may run unsandboxed and to check `sandbox`.
test('start_browser and browser_info descriptions mention the unsandboxed fallback', () => {
  for (const name of ['start_browser', 'browser_info']) {
    const d = manifest.mcp.tools.find((t) => t.name === name).description;
    assert.match(d, /unsandboxed/i, name);
    assert.match(d, /sandbox/, name);
    assert.match(d, /`sandbox`/, name);
  }
});
