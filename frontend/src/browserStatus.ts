import type { BrowserSummary } from './protocol';

export interface StatusPart { text: string; warn?: true }

const STATUS_WORD = { running: 'Running', stopped: 'Stopped', connecting: 'Connecting' } as const;
const controllerPart = (b: BrowserSummary): StatusPart => ({ text: b.controller === 'human' ? 'human control' : 'agent control' });

// The facts shown on a browser row's one status line, in order.
export function statusParts(b: BrowserSummary): StatusPart[] {
  const parts: StatusPart[] = [{ text: STATUS_WORD[b.status] }];
  if (b.kind === 'attached' && b.attached) {
    const a = b.attached;
    parts.push({ text: 'attached' }, { text: a.via === 'proxy' ? 'via proxy' : 'direct' }, { text: a.address });
    if (a.asksApproval) parts.push({ text: 'asks approval' });
    if (b.status === 'running') parts.push(controllerPart(b));
    if (b.status === 'stopped' && b.lastExit) parts.push({ text: 'Disconnected', warn: true });
    return parts;
  }
  if (b.status === 'running') parts.push(controllerPart(b));
  if (b.status === 'running' && b.sandbox === false) parts.push({ text: 'no sandbox', warn: true });
  if (b.allowUnsandboxed) parts.push({ text: 'allowed without sandbox', warn: true });
  if (b.sandboxUnavailable && !b.allowUnsandboxed) parts.push({ text: 'not started: no sandbox', warn: true });
  if (b.status === 'stopped' && b.lastExit) parts.push({ text: 'Crashed', warn: true });
  return parts;
}
