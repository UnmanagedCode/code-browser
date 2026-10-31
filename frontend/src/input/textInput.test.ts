import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InputMessage } from '../protocol';
import { attachTextInput } from './textInput';

let ta: HTMLTextAreaElement;
let sent: InputMessage[];
let detach: () => void;
beforeEach(() => {
  ta = document.createElement('textarea');
  document.body.append(ta);
  sent = [];
  detach = attachTextInput(ta, (m) => sent.push(m));
});
afterEach(() => { detach(); ta.remove(); });

// happy-dom's CompositionEvent ignores `data` in its init dict; real browsers set it.
const composition = (type: string, data: string) => {
  const e = new CompositionEvent(type);
  Object.defineProperty(e, 'data', { value: data });
  return e;
};

const beforeInput = (inputType: string, data?: string) => {
  const e = new InputEvent('beforeinput', { inputType, data, cancelable: true, bubbles: true });
  ta.dispatchEvent(e);
  return e;
};

describe('textInput', () => {
  // Invariant: typed text from a soft keyboard becomes a text message, and the event's default is cancelled so the sink stays empty.
  it('insertText becomes a text message', () => {
    ta.value = 'x';
    const e = beforeInput('insertText', 'héllo');
    expect(sent).toEqual([{ kind: 'text', text: 'héllo' }]);
    expect(e.defaultPrevented).toBe(true);
    expect(ta.value).toBe('');
  });

  // Invariant: Backspace and Enter from soft keyboards become real key presses (down then up).
  it('deleteContentBackward and insertLineBreak become key presses', () => {
    beforeInput('deleteContentBackward');
    beforeInput('insertLineBreak');
    expect(sent.map((m) => (m.kind === 'key' ? `${m.key}:${m.action}` : m.kind))).toEqual(['Backspace:down', 'Backspace:up', 'Enter:down', 'Enter:up']);
    expect(sent.filter((m) => m.kind === 'key').map((m) => m.kind === 'key' && m.keyCode)).toEqual([8, 8, 13, 13]);
  });

  // Invariant: IME composition is forwarded as composition updates and committed as text, not as key events.
  it('composition events map to ime then text', () => {
    ta.dispatchEvent(composition('compositionupdate', 'に'));
    ta.dispatchEvent(composition('compositionupdate', 'にほ'));
    ta.dispatchEvent(composition('compositionend', '日本'));
    expect(sent).toEqual([
      { kind: 'ime', text: 'に', selectionStart: 1, selectionEnd: 1 },
      { kind: 'ime', text: 'にほ', selectionStart: 2, selectionEnd: 2 },
      { kind: 'text', text: '日本' },
    ]);
  });

  // Invariant: inputType values the panel does not map (e.g. composition text) are left alone.
  it('unmapped input types send nothing', () => {
    const e = beforeInput('insertCompositionText', 'x');
    expect(sent).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  // Invariant: paste sends the clipboard's plain text as a text message.
  it('paste becomes a text message', () => {
    const e = new Event('paste', { cancelable: true, bubbles: true }) as ClipboardEvent;
    Object.defineProperty(e, 'clipboardData', { value: { getData: (t: string) => (t === 'text/plain' ? 'pasted' : '') } });
    ta.dispatchEvent(e);
    expect(sent).toEqual([{ kind: 'text', text: 'pasted' }]);
    expect(e.defaultPrevented).toBe(true);
  });
});
