import { CodedError } from '../../src/errors.js';
import { createHelperInfo } from '../../src/helperInfo.js';

// The `helper` field for MCP tests: a plugin dir, data dir and port of no real backend.
export const testHelperInfo = createHelperInfo({ pluginDir: '/plug', dataDir: '/data', port: () => 7470 });

// A manager double for the MCP tool tests: the summary shape of the real manager, with canned tabs.
export function fakeManager({ controller = 'agent', sandbox = true, refuse = false, attached = null, asksApproval = false, tabs = null } = {}) {
  const state = new Map();
  const grants = [];
  const summaryOf = (n) => {
    const e = state.get(n);
    if (!e) throw new CodedError('NOT_FOUND', `no browser named '${n}'`);
    return e;
  };
  return {
    grants,
    state,
    setAllowUnsandboxed: async (...a) => { grants.push(a); },
    list: () => [...state.values()],
    summary: summaryOf,
    ensure: (n) => {
      if (state.has(n)) return;
      const common = { name: n, controller: 'agent', lastExit: null, cdpEndpoint: null, status: 'stopped', sandbox: null, allowUnsandboxed: false, sandboxUnavailable: false };
      state.set(n, attached
        ? { ...common, kind: 'attached', attached: { address: '127.0.0.1:9222', via: attached, asksApproval: null }, attachError: null }
        : { ...common, kind: 'launched', attached: null, attachError: null });
    },
    start: async (n) => {
      if (attached) throw new CodedError('ATTACHED', `'${n}' is the user's own browser, attached in the panel`);
      if (refuse) throw new CodedError('SANDBOX_UNAVAILABLE', `Chromium has no usable sandbox on this host, and browser '${n}' is not allowed to run without one`);
      Object.assign(state.get(n), { status: 'running', sandbox, controller, cdpEndpoint: 'http://127.0.0.1:9333' });
    },
    stop: async (n) => { summaryOf(n).status = 'stopped'; },
    info: async (n) => {
      const e = summaryOf(n);
      if (e.status !== 'running') throw new CodedError('NOT_RUNNING', `browser '${n}' is stopped`);
      const list = tabs ?? [{ targetId: 'T1', url: attached ? 'https://mail.test/' : 'about:blank', title: attached ? 'Mail' : '', active: !attached }];
      if (attached) {
        return { ...e, attached: { ...e.attached, asksApproval }, cdpEndpoint: asksApproval ? 'ws://127.0.0.1:9333/devtools/browser' : 'http://127.0.0.1:9333', controller, sandbox: null, tabs: list, activeTargetId: null };
      }
      return { ...e, tabs: list, activeTargetId: list.find((t) => t.active)?.targetId ?? null };
    },
  };
}
