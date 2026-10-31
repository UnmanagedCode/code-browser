import type { InputMessage } from '../protocol';

// Text arriving through a hidden textarea: mobile and IME keyboards produce beforeinput and composition
// events instead of usable key events (keys.ts skips those). `send` receives the resulting messages.
export function attachTextInput(el: HTMLTextAreaElement, send: (m: InputMessage) => void): () => void {
  const tap = (key: string, code: string, keyCode: number): void => {
    for (const action of ['down', 'up'] as const) send({ kind: 'key', action, key, code, keyCode, location: 0, modifiers: 0, autoRepeat: false });
  };
  const clear = () => { el.value = ''; };

  const onBeforeInput = (e: InputEvent) => {
    switch (e.inputType) {
      case 'insertText':
        if (e.data) send({ kind: 'text', text: e.data });
        break;
      case 'deleteContentBackward': tap('Backspace', 'Backspace', 8); break;
      case 'insertLineBreak': tap('Enter', 'Enter', 13); break;
      default: return; // composition updates are handled by the composition events below
    }
    e.preventDefault();
    clear();
  };
  const onCompositionUpdate = (e: CompositionEvent) => {
    send({ kind: 'ime', text: e.data, selectionStart: e.data.length, selectionEnd: e.data.length });
  };
  const onCompositionEnd = (e: CompositionEvent) => {
    send({ kind: 'text', text: e.data });
    clear();
  };
  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData('text/plain');
    if (text) send({ kind: 'text', text });
    e.preventDefault();
  };

  el.addEventListener('beforeinput', onBeforeInput);
  el.addEventListener('compositionupdate', onCompositionUpdate);
  el.addEventListener('compositionend', onCompositionEnd);
  el.addEventListener('paste', onPaste);
  return () => {
    el.removeEventListener('beforeinput', onBeforeInput);
    el.removeEventListener('compositionupdate', onCompositionUpdate);
    el.removeEventListener('compositionend', onCompositionEnd);
    el.removeEventListener('paste', onPaste);
  };
}
