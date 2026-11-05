import { describe, expect, it } from 'vitest';
import { statusParts } from './browserStatus';
import type { BrowserSummary } from './protocol';

const base: BrowserSummary = { name: 'a', kind: 'launched', status: 'running', controller: 'agent', sandbox: true, allowUnsandboxed: false, sandboxUnavailable: false, lastExit: null, attached: null, attachError: null };
const texts = (b: Partial<BrowserSummary>) => statusParts({ ...base, ...b }).map((p) => p.text);
const attached = { address: '127.0.0.1:9222', via: 'proxy' as const, asksApproval: true };

describe('statusParts', () => {
  // Invariant: a launched browser's line carries its status, who controls it, and each sandbox/crash warning.
  it('launched browsers', () => {
    expect(texts({})).toEqual(['Running', 'agent control']);
    expect(texts({ controller: 'human' })).toEqual(['Running', 'human control']);
    expect(texts({ sandbox: false, allowUnsandboxed: true })).toEqual(['Running', 'agent control', 'no sandbox', 'allowed without sandbox']);
    expect(texts({ status: 'stopped', sandboxUnavailable: true })).toEqual(['Stopped', 'not started: no sandbox']);
    expect(texts({ status: 'stopped', lastExit: { code: 1, signal: null, at: 1 } })).toEqual(['Stopped', 'Crashed']);
    expect(statusParts({ ...base, status: 'stopped', lastExit: { code: 1, signal: null, at: 1 } }).at(-1)?.warn).toBe(true);
  });

  // Invariant: an attached browser's line names how and where it is reached, plus approval and disconnect state.
  it('attached browsers', () => {
    expect(texts({ kind: 'attached', attached })).toEqual(['Running', 'attached', 'via proxy', '127.0.0.1:9222', 'asks approval', 'agent control']);
    expect(texts({ kind: 'attached', status: 'connecting', attached: { ...attached, via: 'direct', asksApproval: null } })).toEqual(['Connecting', 'attached', 'direct', '127.0.0.1:9222']);
    expect(texts({ kind: 'attached', status: 'stopped', attached, lastExit: { code: null, signal: null, at: 1 } })).toEqual(['Stopped', 'attached', 'via proxy', '127.0.0.1:9222', 'asks approval', 'Disconnected']);
  });

  // Invariant: an unknown or prototype-named status renders a neutral word instead of throwing.
  it('unknown statuses do not throw', () => {
    for (const status of ['__proto__', 'toString', 'weird']) expect(texts({ status: status as BrowserSummary['status'] })[0]).toBe('Unknown');
  });
});
