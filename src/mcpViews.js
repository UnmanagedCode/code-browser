// The text view of each tool: prose rendered from the complete data the handler in src/mcp.js returns.
// A view answers {text, meta?}; it never drops information the agent needs to act.

const lit = (v) => JSON.stringify(v);

function listBrowsers({ browsers }) {
  if (browsers.length === 0) return { text: 'No browsers yet. start_browser creates one (name defaults to "default").' };
  const lines = browsers.map((b) => {
    const parts = [`kind ${b.kind}`, `status ${b.status}`, `controller ${b.controller}`, `cdpEndpoint ${lit(b.cdpEndpoint)}`, `sandbox ${lit(b.sandbox)}`, `allowUnsandboxed ${lit(b.allowUnsandboxed)}`];
    if (b.attached) parts.push(`attached ${b.attached.address} via ${b.attached.via}`, `asksApproval ${lit(b.attached.asksApproval)}`);
    if (b.sandboxUnavailable) parts.push('sandboxUnavailable true (a human must enable "Allow without sandbox" in the panel)');
    if (b.lastExit) parts.push(`lastExit code ${lit(b.lastExit.code)} signal ${lit(b.lastExit.signal)} at ${new Date(b.lastExit.at).toISOString()}`);
    if (b.attachError) parts.push(`attachError ${lit(b.attachError)}`);
    return `- ${b.name}: ${parts.join(', ')}`;
  });
  return { text: [`${browsers.length} browser(s):`, ...lines, 'Call browser_info <name> for tabs and the Playwright snippet.'].join('\n') };
}

function browserInfo(d) {
  const text = [
    ...d.notes.flatMap((note) => [note, '']),
    `Panel: ${d.panelPath} — it is relative to the address the user opens cc at. Give it to the user as-is, or as a markdown link with that path as the target. Do not add a host.`,
    '',
    'Rules:',
    ...d.rules.map((rule) => `- ${rule}`),
    '',
    'Save this as an .mjs file and run it with node via Bash:',
    '```js',
    d.snippet.trimEnd(),
    '```',
  ].join('\n');
  const meta = {
    name: d.name,
    kind: d.kind,
    status: d.status,
    attached: d.attached,
    cdpEndpoint: d.cdpEndpoint,
    controller: d.controller,
    sandbox: d.sandbox,
    allowUnsandboxed: d.allowUnsandboxed,
    tabs: d.tabs,
    panelPath: d.panelPath,
  };
  return { text, meta };
}

function stopBrowser({ name, kind }) {
  return {
    text: kind === 'attached'
      ? `Disconnected code-browser from '${name}', the user's own browser: it and its tabs keep running, and only the user can reconnect it (Connect in the code-browser panel).`
      : `Stopped browser '${name}'. Its profile (logins, cookies) is kept; start_browser brings it back.`,
  };
}

export const TEXT_VIEWS = {
  list_browsers: listBrowsers,
  start_browser: browserInfo,
  stop_browser: stopBrowser,
  browser_info: browserInfo,
};
