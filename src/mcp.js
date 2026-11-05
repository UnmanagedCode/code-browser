import { CodedError } from './errors.js';
import { DEFAULT_BROWSER_NAME, DEFAULT_WINDOW } from './limits.js';
import { assertName } from './browserManager.js';
import { panelPath } from './panelLink.js';
import { buildSnippet } from './snippet.js';

const HUMAN_NOTE = 'A human currently has control of this browser. Do not drive it: do not click, type or navigate. '
  + 'Call browser_info again later; it shows controller "agent" once control is back.';

const UNSANDBOXED_NOTE = "WARNING: this browser runs without Chromium's sandbox (the host has no usable one), so a compromised page could "
  + 'run code as the host user. Do not browse untrusted pages in it, especially with logged-in profiles.';

const ATTACHED_NOTE = "This is the user's own browser, which they attached in the panel: its other tabs and logged-in sessions are theirs. "
  + "Work in your own tab and do not close tabs you did not open. `sandbox` is null because code-browser did not launch it, "
  + 'so nothing is known about its sandbox or profile. stop_browser only disconnects, and only the user can reconnect it. '
  + 'A person may be using its window right now.';

const APPROVAL_NOTE = 'Chrome asks the user "Allow remote debugging?" for every connection to this browser, and each script you run '
  + 'opens a new one. Tell the user before you run a script; it waits until they click Allow and fails with 403 if they cancel. '
  + 'Do the work in as few scripts as possible.';

const attachedOnly = (err, name, path) => new CodedError(err.code, `${err.message}. Browser '${name}' is the user's own browser; ask the user to `
  + `press Connect for it in the code-browser panel: ${path} (relative to the address the user opens cc at; do not add a host).`);

const sandboxUnavailable = (err, path) => new CodedError(err.code, `${err.message}. A human must enable "Allow without sandbox" for this browser in the code-browser panel: ${path} `
  + '(relative to the address the user opens cc at; do not add a host). You cannot enable it yourself: ask the user, then call start_browser again.');

// cc POSTs {tool, arguments, caller} and expects HTTP 200 with {result}, {error} or {text, meta?}.
export function createMcp({ manager, pluginDir, pluginId }) {
  const nameOf = (args) => assertName(args?.name ?? DEFAULT_BROWSER_NAME);

  async function browserInfo(name) {
    const path = panelPath(name, pluginId);
    let info;
    try {
      info = await manager.info(name);
    } catch (err) {
      if (err.code !== 'NOT_RUNNING') throw err;
      throw manager.list().find((b) => b.name === name)?.kind === 'attached' ? attachedOnly(err, name, path) : err;
    }
    const attached = info.kind === 'attached';
    const meta = {
      name: info.name,
      kind: info.kind,
      status: info.status,
      attached: info.attached,
      cdpEndpoint: info.cdpEndpoint,
      controller: info.controller,
      sandbox: info.sandbox,
      allowUnsandboxed: info.allowUnsandboxed,
      tabs: info.tabs,
      panelPath: path,
    };
    const text = [
      ...(info.controller === 'human' ? [HUMAN_NOTE, ''] : []),
      ...(info.sandbox === false ? [UNSANDBOXED_NOTE, ''] : []),
      ...(attached ? [ATTACHED_NOTE, ''] : []),
      ...(info.attached?.asksApproval ? [APPROVAL_NOTE, ''] : []),
      `Panel: ${path} — it is relative to the address the user opens cc at. Give it to the user as-is, or as a markdown link with that path as the target. Do not add a host.`,
      '',
      'Rules:',
      '- Use `browser.contexts()[0]`, never `newContext()`: a new context is incognito and not shared with the panel.',
      '- `browser.close()` only disconnects; the browser keeps running.',
      ...(info.kind === 'launched' ? [`- The page viewport is ${DEFAULT_WINDOW.width} px wide; its height follows the shape of the person's panel and can change between scripts. Read innerHeight instead of assuming it, and do not set your own viewport (page.setViewportSize): it conflicts with the panel's.`] : []),
      '',
      'Save this as an .mjs file and run it with node via Bash:',
      '```js',
      buildSnippet({ pluginDir, cdpEndpoint: info.cdpEndpoint, activeTargetId: info.activeTargetId, attached, asksApproval: info.attached?.asksApproval === true }).trimEnd(),
      '```',
    ].join('\n');
    return { text, meta };
  }

  const handlers = {
    list_browsers: async () => ({ result: manager.list() }),
    start_browser: async (args) => {
      const name = nameOf(args);
      manager.ensure(name);
      try {
        await manager.start(name);
      } catch (err) {
        if (err.code === 'SANDBOX_UNAVAILABLE') throw sandboxUnavailable(err, panelPath(name, pluginId));
        if (err.code === 'ATTACHED') throw attachedOnly(err, name, panelPath(name, pluginId));
        throw err;
      }
      return browserInfo(name);
    },
    stop_browser: async (args) => {
      const name = nameOf(args);
      await manager.stop(name);
      return { result: { name, status: 'stopped' } };
    },
    browser_info: async (args) => browserInfo(nameOf(args)),
  };

  // Never throws: every failure is an {error} the caller still receives with HTTP 200.
  async function handle(body) {
    const handler = Object.hasOwn(handlers, body?.tool) ? handlers[body.tool] : null;
    if (!handler) return { error: `UNKNOWN_TOOL: no tool named ${JSON.stringify(body?.tool)}` };
    try {
      return await handler(body.arguments ?? {});
    } catch (err) {
      if (!(err instanceof CodedError)) console.error(`code-browser: tool ${body.tool} failed:`, err);
      return { error: `${err.code ?? 'INTERNAL'}: ${err.message}` };
    }
  }

  return { handle, toolNames: Object.keys(handlers) };
}
