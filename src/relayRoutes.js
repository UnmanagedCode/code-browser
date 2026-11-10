// The CDP relay's routing rules as pure functions (docs/protocol.md → CDP relay). The relay (cdpRelay.js) owns the
// sockets and the upstream connection; these decide what a message may do and where an event goes.

// What Chrome answers for a session it does not know; a relay client gets the same for a session that is not its own.
export const UNKNOWN_SESSION = { code: -32001, message: 'Session with given id not found.' };
const REFUSED = -32000;

// Methods no relay client may send: closing or crashing the shared browser, and the non-flat transport, whose
// replies the relay could not route.
const FORBIDDEN = new Set(['Browser.close', 'Browser.crash', 'Browser.crashGpuProcess', 'Target.sendMessageToTarget']);
const NEEDS_FLATTEN = new Set(['Target.attachToTarget', 'Target.setAutoAttach', 'Target.autoAttachRelated']);

// A client frame → `{msg}` or `{close: code, reason}`. 1003: binary; 1007: not a JSON command envelope.
export function parseClientMessage(data, isBinary) {
  if (isBinary) return { close: 1003, reason: 'binary messages are not accepted' };
  let msg;
  try { msg = JSON.parse(data.toString('utf8')); } catch { return { close: 1007, reason: 'message is not JSON' }; }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg) || !Number.isSafeInteger(msg.id) || typeof msg.method !== 'string') {
    return { close: 1007, reason: 'message is not a CDP command' };
  }
  if (msg.sessionId !== undefined && typeof msg.sessionId !== 'string') return { close: 1007, reason: 'sessionId must be a string' };
  if (msg.params !== undefined && (typeof msg.params !== 'object' || msg.params === null || Array.isArray(msg.params))) {
    return { close: 1007, reason: 'params must be an object' };
  }
  return { msg };
}

// A client command → `{sessionId}` (the upstream session to send it on) or `{error}` (answered without sending
// anything upstream). `owns(sessionId)` is true for the client's own child sessions; its root is `root`.
export function commandVerdict({ method, params = {}, sessionId }, { root, owns }) {
  if (sessionId !== undefined && (sessionId === root || !owns(sessionId))) return { error: UNKNOWN_SESSION };
  if (FORBIDDEN.has(method)) return { error: { code: REFUSED, message: `${method} is not allowed through code-browser's relay` } };
  if (NEEDS_FLATTEN.has(method) && params.flatten !== true) {
    return { error: { code: REFUSED, message: `${method} needs flatten: true through code-browser's relay` } };
  }
  if (method === 'Target.detachFromTarget' && !(typeof params.sessionId === 'string' && params.sessionId !== root && owns(params.sessionId))) {
    return { error: { code: REFUSED, message: "Target.detachFromTarget needs the sessionId of one of this client's own sessions" } };
  }
  return { sessionId: sessionId ?? root };
}

// The session a successful command's result hands its sender, or null.
export function sessionFromResult(method, result) {
  if ((method === 'Target.attachToTarget' || method === 'Target.attachToBrowserTarget') && typeof result?.sessionId === 'string') {
    return result.sessionId;
  }
  return null;
}

// What an upstream event does to session ownership: an attach on an owned session gives its owner the new
// child; a detach takes one away. `{register}` / `{unregister}` / null.
export function ownershipChange({ method, params }) {
  if (method === 'Target.attachedToTarget' && typeof params?.sessionId === 'string') return { register: params.sessionId };
  if (method === 'Target.detachedFromTarget' && typeof params?.sessionId === 'string') return { unregister: params.sessionId };
  return null;
}

// The message a client receives for an upstream event on one of its sessions: on its root, the event without a
// sessionId (the client sees its root as its own connection); on a child, unchanged.
export function eventForClient({ method, params, sessionId }, root) {
  return sessionId === root ? { method, params } : { method, params, sessionId };
}

// The answer to a client command: its own id, and its sessionId only when it sent one.
export function replyForClient(id, sessionId, answer) {
  const out = { id, ...(answer.error ? { error: answer.error } : { result: answer.result }) };
  if (sessionId !== undefined) out.sessionId = sessionId;
  return out;
}
