import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The panel's styles.css carries a standalone fallback of the host palette (embedded in code-conductor, the host
// sheet wins). Two checks:
//  - always on: every token the stylesheet reads is declared by the fallback, in both themes;
//  - opt-in (CODE_CONDUCTOR_DIR): the fallback values equal the host's themeTokens.css. The fallback is a snapshot
//    that is never re-synced by design, so this is a drift check you run on demand, not a duty to track the host.
const css = fs.readFileSync(new URL('../frontend/src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Declarations of `--name: value;` inside the first block whose selector is `selector`.
function declarations(source, selector) {
  const open = source.indexOf(`${selector} {`);
  if (open < 0) return new Map();
  const body = source.slice(open + selector.length + 2, source.indexOf('}', open));
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].replace(/\s+/g, ' ').trim()]));
}
const base = css.slice(css.indexOf('@layer base'));
const light = declarations(base, ':root');
const dark = declarations(base, '.dark');

test('the token parser finds a known token in both themes', () => {
  assert.ok(light.has('--primary'), ':root declares --primary');
  assert.ok(dark.has('--primary'), '.dark declares --primary');
});

// Invariant: nothing in the stylesheet reads a token the fallback does not declare (--cc-session-width has its own fallback).
test('every var(--x) the stylesheet reads is declared in the fallback', () => {
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  used.delete('--cc-session-width');
  for (const token of used) assert.ok(light.has(token), `${token} is declared in :root`);
});

// Invariant: both themes declare the same tokens (--radius is theme-independent and lives in :root only).
test('light and dark declare the same token set', () => {
  const names = (m) => [...m.keys()].filter((k) => k !== '--radius').sort();
  assert.deepEqual(names(dark), names(light));
});

test('fallback values equal the host themeTokens.css', (t) => {
  const dir = process.env.CODE_CONDUCTOR_DIR;
  if (!dir) { t.skip('set CODE_CONDUCTOR_DIR to a code-conductor checkout'); return; }
  const file = `${dir}/web/src/themeTokens.css`;
  assert.ok(fs.existsSync(file), `CODE_CONDUCTOR_DIR is set but ${file} is missing`);
  const host = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const hostLight = declarations(host, ':root');
  const hostDark = declarations(host, '.dark');
  for (const [token, value] of light) assert.equal(value, hostLight.get(token), `:root ${token}`);
  for (const [token, value] of dark) assert.equal(value, hostDark.get(token), `.dark ${token}`);
});
