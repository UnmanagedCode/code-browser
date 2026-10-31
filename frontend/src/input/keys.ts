import type { InputMessage } from '../protocol';

type KeyMessage = Extract<InputMessage, { kind: 'key' }>;

// CDP modifier bitmask: Alt=1, Ctrl=2, Meta/Command=4, Shift=8.
export const modifiersOf = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

// A KeyboardEvent as an input message, or null when textInput.ts owns it instead: IME composition
// and Android's key 'Unidentified' (keyCode 229) arrive as beforeinput/composition events.
export function keyMessage(e: KeyboardEvent, action: 'down' | 'up'): KeyMessage | null {
  if (e.isComposing || e.key === 'Unidentified' || e.keyCode === 229) return null;
  const printable = [...e.key].length === 1 && !e.ctrlKey && !e.metaKey;
  return {
    kind: 'key', action, key: e.key, code: e.code, keyCode: e.keyCode, location: e.location,
    modifiers: modifiersOf(e), autoRepeat: e.repeat,
    ...(printable && action === 'down' ? { text: e.key } : {}),
  };
}

// Paste arrives through the `paste` event as text, so the keystroke itself must not also be sent.
export const isPasteChord = (e: KeyboardEvent): boolean => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v';
