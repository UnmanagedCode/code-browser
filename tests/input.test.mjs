import test from 'node:test';
import assert from 'node:assert/strict';
import { inputToCdp, normalizeUrl } from '../src/input.js';

// Invariant: every panel input kind maps to the CDP command that carries it out.
test('mouse down/up/move and wheel map to Input.dispatchMouseEvent', () => {
  const down = inputToCdp({ kind: 'mouse', action: 'down', x: 10.5, y: 20, button: 'left', buttons: 1, clickCount: 1, modifiers: 2 });
  assert.deepEqual(down, { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 10.5, y: 20, button: 'left', buttons: 1, clickCount: 1, modifiers: 2 } });
  assert.equal(inputToCdp({ kind: 'mouse', action: 'up', x: 1, y: 1, button: 'left' }).params.type, 'mouseReleased');
  const move = inputToCdp({ kind: 'mouse', action: 'move', x: 1, y: 1 });
  assert.equal(move.params.type, 'mouseMoved');
  assert.equal(move.params.button, 'none');
  const wheel = inputToCdp({ kind: 'wheel', x: 5, y: 6, deltaY: 120 });
  assert.deepEqual(wheel.params, { type: 'mouseWheel', x: 5, y: 6, deltaX: 0, deltaY: 120, modifiers: 0 });
});

// Invariant: printable keys go as keyDown with text; others as rawKeyDown; releases as keyUp.
test('key mapping: keyDown with text, rawKeyDown without, keyUp', () => {
  const base = { kind: 'key', key: 'a', code: 'KeyA', keyCode: 65, location: 0, modifiers: 0 };
  const printable = inputToCdp({ ...base, action: 'down', text: 'a' });
  assert.equal(printable.params.type, 'keyDown');
  assert.equal(printable.params.text, 'a');
  assert.equal(printable.params.windowsVirtualKeyCode, 65);
  assert.equal(inputToCdp({ ...base, action: 'down', key: 'Enter', keyCode: 13 }).params.type, 'rawKeyDown');
  const up = inputToCdp({ ...base, action: 'up' });
  assert.equal(up.params.type, 'keyUp');
  assert.equal('text' in up.params, false);
  assert.equal(inputToCdp({ ...base, action: 'down', autoRepeat: true, text: 'a' }).params.autoRepeat, true);
});

test('text and ime map to insertText and imeSetComposition', () => {
  assert.deepEqual(inputToCdp({ kind: 'text', text: 'héllo' }), { method: 'Input.insertText', params: { text: 'héllo' } });
  assert.deepEqual(inputToCdp({ kind: 'ime', text: 'あ', selectionStart: 1, selectionEnd: 1 }), { method: 'Input.imeSetComposition', params: { text: 'あ', selectionStart: 1, selectionEnd: 1 } });
});

// Invariant: malformed input is refused with INVALID_INPUT and numbers are clamped, never passed through raw.
test('validation and clamping', () => {
  const bad = (m) => assert.throws(() => inputToCdp(m), (e) => e.code === 'INVALID_INPUT', JSON.stringify(m));
  bad({ kind: 'nope' });
  bad({ kind: 'mouse', action: 'hover', x: 1, y: 1 });
  bad({ kind: 'mouse', action: 'down', x: 'a', y: 1 });
  bad({ kind: 'mouse', action: 'down', x: NaN, y: 1 });
  bad({ kind: 'mouse', action: 'down', x: 1, y: 1, button: 'thumb' });
  bad({ kind: 'key', action: 'press', key: 'a' });
  bad({ kind: 'key', action: 'down', key: 'x'.repeat(33) });
  bad({ kind: 'key', action: 'down', key: 'a', text: 'x'.repeat(9) });
  bad({ kind: 'text', text: 5 });
  bad({ kind: 'text', text: 'x'.repeat(8193) });
  const clamped = inputToCdp({ kind: 'mouse', action: 'move', x: -5, y: 1e12, modifiers: 99, clickCount: 9 }).params;
  assert.equal(clamped.x, 0);
  assert.equal(clamped.y, 1e6);
  assert.equal(clamped.modifiers, 15);
  assert.equal(clamped.clickCount, 3);
  assert.equal(inputToCdp({ kind: 'wheel', x: 1, y: 1, deltaY: 1e9 }).params.deltaY, 1e4);
});

// Invariant: the URL bar only reaches http(s) and about:blank; a bare host gets https://.
test('normalizeUrl', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeUrl(' http://localhost:3000/a?b=1 '), 'http://localhost:3000/a?b=1');
  assert.equal(normalizeUrl('localhost:3000'), 'https://localhost:3000/');
  assert.equal(normalizeUrl('about:blank'), 'about:blank');
  for (const bad of ['', '   ', 'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'chrome://settings', 'ftp://x.test', 'ws://x.test', 'about:srcdoc', 'https://', 'http://exa mple.com', 'x'.repeat(2049), null, 5]) {
    assert.throws(() => normalizeUrl(bad), (e) => e.code === 'BAD_URL', String(bad));
  }
});
