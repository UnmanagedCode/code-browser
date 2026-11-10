import { CodedError } from './errors.js';
import { DEFAULT_BROWSER_NAME, DEFAULT_WINDOW } from './limits.js';
import { assertName } from './browserManager.js';
import { panelPath } from './panelLink.js';
import { buildSnippet } from './snippet.js';
import { TEXT_VIEWS } from './mcpViews.js';
import { APPROVAL_NOTE, ATTACHED_NOTE, HUMAN_NOTE, UNSANDBOXED_NOTE } from './notes.js';

const RELATIVE_PATH = 'relative to the address the user opens cc at; do not add a host';

// The refusals this module composes carry the panel path in details, not in the message.
const attachedOnly = (err, name, details) => new CodedError(err.code, `${err.message}. Browser '${name}' is the user's own browser; ask the user to `
  + `press Connect for it in the code-browser panel, at details.panelPath (${RELATIVE_PATH}).`, details);

const sandboxUnavailable = (err, details) => new CodedError(err.code, `${err.message}. A human must enable "Allow without sandbox" for this browser in the code-browser panel, `
  + `at details.panelPath (${RELATIVE_PATH}). You cannot enable it yourself: ask the user, then call start_browser again.`, details);

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// A caller-supplied value, shortened so a huge one is not echoed whole. Never throws: a deeply nested value overflows
// JSON.stringify, a BigInt or a hostile toString throws, and a refusal must still be built.
function echo(v) {
  let text;
  try { text = v === undefined ? 'undefined' : JSON.stringify(v) ?? String(v); } catch {
    try { text = String(v); } catch {
      try { text = Object.prototype.toString.call(v); } catch { text = '[unprintable]'; }
    }
  }
  return text.slice(0, 80);
}

// instanceof runs a Proxy's getPrototypeOf trap, which a revoked Proxy makes throw.
function isCoded(err) {
  try { return err instanceof CodedError; } catch { return false; }
}

// An error's message without trusting it: a thrown object's getters and toString are foreign code.
function messageOf(err) {
  try { return String(err?.message || err); } catch { return 'unreadable error'; }
}

// cc POSTs {tool, arguments, caller, format} and expects HTTP 200 with exactly one of:
//   format "json" → {structured}   (the tool's complete data; cc validates it against the manifest outputSchema)
//   format "text" → {text, meta?}  (an absent format means text)
//   a refusal     → {error, code, details?}
// Each handler returns the complete json data; src/mcpViews.js renders the text from it.
// `helperInfo(name)` builds the `helper` field (src/helperInfo.js).
export function createMcp({ manager, pluginDir, pluginId, helperInfo }) {
  const nameOf = (args) => assertName(args.name ?? DEFAULT_BROWSER_NAME);

  async function browserInfo(name) {
    const path = panelPath(name, pluginId);
    let info;
    try {
      info = await manager.info(name);
    } catch (err) {
      if (err.code !== 'NOT_RUNNING') throw err;
      if (manager.summary(name).kind === 'attached') throw attachedOnly(err, name, { name, kind: 'attached', panelPath: path });
      throw new CodedError(err.code, err.message, { name, kind: 'launched' });
    }
    const attached = info.kind === 'attached';
    const asksApproval = info.attached?.asksApproval === true;
    return {
      ...info,
      panelPath: path,
      notes: [
        ...(info.controller === 'human' ? [HUMAN_NOTE] : []),
        ...(info.sandbox === false ? [UNSANDBOXED_NOTE] : []),
        ...(attached ? [ATTACHED_NOTE] : []),
        ...(asksApproval ? [APPROVAL_NOTE] : []),
      ],
      rules: [
        'Use `browser.contexts()[0]`, never `newContext()`: a new context is incognito and not shared with the panel.',
        '`browser.close()` only disconnects; the browser keeps running.',
        ...(info.kind === 'launched' ? [`The page viewport is ${DEFAULT_WINDOW.width} px wide; its height follows the shape of the person's panel and can change between scripts. Read innerHeight instead of assuming it, and do not set your own viewport (page.setViewportSize): it conflicts with the panel's.`] : []),
      ],
      snippet: buildSnippet({ pluginDir, cdpEndpoint: info.cdpEndpoint, activeTargetId: info.activeTargetId, attached, asksApproval }),
      helper: helperInfo(name),
    };
  }

  const handlers = {
    list_browsers: async () => ({ browsers: manager.list() }),
    start_browser: async (args) => {
      const name = nameOf(args);
      manager.ensure(name);
      try {
        await manager.start(name);
      } catch (err) {
        const details = { name, panelPath: panelPath(name, pluginId) };
        if (err.code === 'SANDBOX_UNAVAILABLE') throw sandboxUnavailable(err, details);
        if (err.code === 'ATTACHED') throw attachedOnly(err, name, details);
        throw err;
      }
      return browserInfo(name);
    },
    stop_browser: async (args) => {
      const name = nameOf(args);
      const { kind } = manager.summary(name);
      await manager.stop(name);
      return { name, kind, status: 'stopped' };
    },
    browser_info: async (args) => browserInfo(nameOf(args)),
  };

  // Never throws: every failure is an {error, code} the caller still receives with HTTP 200.
  async function handle(body) {
    const format = body?.format === undefined ? 'text' : body.format;
    if (format !== 'text' && format !== 'json') return { error: `format must be "text" or "json", got ${echo(body.format)}`, code: 'FORMAT_UNKNOWN' };
    const tool = body?.tool;
    if (typeof tool !== 'string' || !Object.hasOwn(handlers, tool)) return { error: `no tool named ${echo(tool)}`, code: 'TOOL_UNKNOWN' };
    const args = body.arguments ?? {};
    if (!isPlainObject(args)) return { error: 'arguments must be an object', code: 'BAD_REQUEST' };
    try {
      const data = await handlers[tool](args);
      if (format === 'json') return { structured: data };
      if (!Object.hasOwn(TEXT_VIEWS, tool)) throw new Error('no text view');
      return TEXT_VIEWS[tool](data);
    } catch (err) {
      if (isCoded(err)) return { error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) };
      try { console.error(`code-browser: tool ${tool} failed:`, err); } catch { /* logging must not fail the refusal */ }
      return { error: `${tool} failed unexpectedly: ${messageOf(err)}`, code: 'INTERNAL' };
    }
  }

  return { handle, toolNames: Object.keys(handlers) };
}
