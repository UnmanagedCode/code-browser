import { CodedError } from './errors.js';

const invalid = (why) => new CodedError('INVALID_INPUT', why);

function num(v, what, { min = -1e6, max = 1e6 } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(`${what} must be a finite number`);
  return Math.min(max, Math.max(min, v));
}
const int = (v, what, range) => Math.round(num(v ?? 0, what, range));
const str = (v, what, max) => {
  if (typeof v !== 'string' || v.length > max) throw invalid(`${what} must be a string of at most ${max} characters`);
  return v;
};
const modifiers = (v) => int(v, 'modifiers', { min: 0, max: 15 });

const MOUSE_TYPES = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' };
const BUTTONS = new Set(['none', 'left', 'middle', 'right']);

// Validated, clamped panel input message → the CDP command that carries it out.
export function inputToCdp(msg) {
  switch (msg.kind) {
    case 'mouse': {
      const type = MOUSE_TYPES[msg.action];
      if (!type) throw invalid('mouse action must be down, up or move');
      const button = msg.button ?? 'none';
      if (!BUTTONS.has(button)) throw invalid('unknown mouse button');
      return {
        method: 'Input.dispatchMouseEvent',
        params: {
          type, x: num(msg.x, 'x', { min: 0 }), y: num(msg.y, 'y', { min: 0 }), button,
          buttons: int(msg.buttons, 'buttons', { min: 0, max: 31 }),
          clickCount: int(msg.clickCount, 'clickCount', { min: 0, max: 3 }),
          modifiers: modifiers(msg.modifiers),
        },
      };
    }
    case 'wheel':
      return {
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseWheel', x: num(msg.x, 'x', { min: 0 }), y: num(msg.y, 'y', { min: 0 }),
          deltaX: num(msg.deltaX ?? 0, 'deltaX', { min: -1e4, max: 1e4 }),
          deltaY: num(msg.deltaY ?? 0, 'deltaY', { min: -1e4, max: 1e4 }),
          modifiers: modifiers(msg.modifiers),
        },
      };
    case 'key': {
      if (msg.action !== 'down' && msg.action !== 'up') throw invalid('key action must be down or up');
      const text = msg.text === undefined ? undefined : str(msg.text, 'text', 8);
      const params = {
        key: str(msg.key, 'key', 32), code: str(msg.code ?? '', 'code', 32),
        windowsVirtualKeyCode: int(msg.keyCode, 'keyCode', { min: 0, max: 65535 }),
        location: int(msg.location, 'location', { min: 0, max: 3 }),
        modifiers: modifiers(msg.modifiers), autoRepeat: msg.autoRepeat === true,
      };
      if (msg.action === 'up') return { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...params } };
      // Printable keys carry their text so the page sees an input event; the rest go raw.
      return text
        ? { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', ...params, text, unmodifiedText: text } }
        : { method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', ...params } };
    }
    case 'text':
      return { method: 'Input.insertText', params: { text: str(msg.text, 'text', 8192) } };
    case 'ime':
      return {
        method: 'Input.imeSetComposition',
        params: {
          text: str(msg.text, 'text', 8192),
          selectionStart: int(msg.selectionStart, 'selectionStart', { min: 0, max: 8192 }),
          selectionEnd: int(msg.selectionEnd, 'selectionEnd', { min: 0, max: 8192 }),
        },
      };
    default:
      throw invalid('unknown input kind');
  }
}

const URL_MAX = 2048;
const FORBIDDEN_SCHEME = /^(javascript|data|file|blob|chrome|chrome-untrusted|view-source|devtools|ws|wss|ftp|vbscript|filesystem):/i;

// What the URL bar may send: http(s) and about:blank. A bare host gets https://.
export function normalizeUrl(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  const bad = (why) => new CodedError('BAD_URL', why);
  if (!raw || raw.length > URL_MAX) throw bad('URL is empty or too long');
  if (raw === 'about:blank') return raw;
  if (FORBIDDEN_SCHEME.test(raw)) throw bad('only http, https and about:blank URLs are allowed');
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try { url = new URL(candidate); } catch { throw bad('not a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw bad('only http, https and about:blank URLs are allowed');
  return url.href;
}
