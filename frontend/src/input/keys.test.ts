import { describe, expect, it } from 'vitest';
import { isPasteChord, keyMessage, modifiersOf } from './keys';

const ev = (init: Partial<KeyboardEvent> & { key: string }) => ({ code: '', keyCode: 0, location: 0, repeat: false, isComposing: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init }) as KeyboardEvent;

describe('keyMessage', () => {
  // Invariant: a printable key goes down with its text (so the page gets an input event); up never carries text.
  it('printable keys carry text on keydown only', () => {
    const down = keyMessage(ev({ key: 'a', code: 'KeyA', keyCode: 65 }), 'down');
    expect(down).toMatchObject({ kind: 'key', action: 'down', key: 'a', code: 'KeyA', keyCode: 65, text: 'a' });
    expect(keyMessage(ev({ key: 'a', code: 'KeyA', keyCode: 65 }), 'up')).not.toHaveProperty('text');
  });

  // Invariant: non-printable keys and shortcut chords go raw (no text).
  it('named keys and ctrl/meta chords have no text', () => {
    expect(keyMessage(ev({ key: 'Enter', keyCode: 13 }), 'down')).not.toHaveProperty('text');
    expect(keyMessage(ev({ key: 'a', ctrlKey: true }), 'down')).not.toHaveProperty('text');
    expect(keyMessage(ev({ key: 'a', metaKey: true }), 'down')).not.toHaveProperty('text');
  });

  // Invariant: modifiers use CDP's bitmask (Alt 1, Ctrl 2, Meta 4, Shift 8).
  it('modifier bitmask', () => {
    expect(modifiersOf({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(1);
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
    expect(keyMessage(ev({ key: 'A', shiftKey: true }), 'down')?.modifiers).toBe(8);
  });

  // Invariant: IME composition and Android's key 229/Unidentified are left to textInput.ts, never sent as keys.
  it('skips composing events, Unidentified and keyCode 229', () => {
    expect(keyMessage(ev({ key: 'a', isComposing: true }), 'down')).toBeNull();
    expect(keyMessage(ev({ key: 'Unidentified', keyCode: 229 }), 'down')).toBeNull();
    expect(keyMessage(ev({ key: 'x', keyCode: 229 }), 'down')).toBeNull();
  });

  // Invariant: auto-repeat is preserved; a multi-code-unit emoji still counts as one printable character.
  it('keeps repeat and treats an astral character as printable', () => {
    expect(keyMessage(ev({ key: 'a', repeat: true }), 'down')?.autoRepeat).toBe(true);
    expect(keyMessage(ev({ key: '😀' }), 'down')).toMatchObject({ text: '😀' });
  });

  // Invariant: the paste chord is recognised so the keystroke is not sent in addition to the pasted text.
  it('isPasteChord', () => {
    expect(isPasteChord(ev({ key: 'v', ctrlKey: true }))).toBe(true);
    expect(isPasteChord(ev({ key: 'V', metaKey: true }))).toBe(true);
    expect(isPasteChord(ev({ key: 'v' }))).toBe(false);
  });
});
