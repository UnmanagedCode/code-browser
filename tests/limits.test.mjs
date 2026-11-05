import test from 'node:test';
import assert from 'node:assert/strict';
import { NAME_RE } from '../src/limits.js';

// Invariant: NAME_RE is valid as an HTML `pattern`, which Chrome compiles as ^(?:source)$ with the v flag.
test('NAME_RE compiles under the v flag', () => {
  assert.doesNotThrow(() => new RegExp(`^(?:${NAME_RE.source})$`, 'v'));
});

// Invariant: the v-flag form accepts and rejects exactly what NAME_RE does.
test('NAME_RE keeps its accept/reject set under the v flag', () => {
  const html = new RegExp(`^(?:${NAME_RE.source})$`, 'v');
  const samples = ['a', 'a-b', '0', 'a'.repeat(40), 'a'.repeat(41), '-a', 'A', 'a_b', '', 'a.b'];
  const accepted = samples.filter((s) => NAME_RE.test(s));
  assert.deepEqual(accepted, ['a', 'a-b', '0', 'a'.repeat(40)]);
  assert.deepEqual(samples.filter((s) => html.test(s)), accepted);
});
