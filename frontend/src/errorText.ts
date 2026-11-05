import { NAME_HINT } from './names';

export interface ToastContent { text: string; code: string | null }

// Codes whose backend message adds nothing for a person. Every other code shows the backend's message, which
// carries specifics such as why an attach failed.
const PLAIN: Record<string, string> = {
  NOT_CONTROLLER: 'Take control first.',
  NOT_VIEWING: 'Open a browser first.',
  NOT_RUNNING: "That browser isn't running.",
  NO_TAB: 'That tab is gone.',
  NO_DIALOG: 'That dialog is already closed.',
  CDP_CLOSED: 'The browser stopped responding.',
  CDP_TIMEOUT: 'The browser stopped responding.',
  INVALID_NAME: NAME_HINT,
};

// Arguments come off the wire, so a malformed frame must not throw: both are coerced to strings.
export function toToast(rawCode: unknown, rawMessage: unknown): ToastContent {
  const code = typeof rawCode === 'string' ? rawCode : null;
  const message = String(rawMessage ?? '');
  if (code !== null && Object.hasOwn(PLAIN, code)) return { text: PLAIN[code], code };
  return { text: message.charAt(0).toUpperCase() + message.slice(1), code };
}
