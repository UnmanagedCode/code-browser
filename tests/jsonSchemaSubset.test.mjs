import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { KEYWORDS, TYPES, checkSchema, validate } from './_jsonSchemaSubset.mjs';

// Invariant: the test-only validator is as strict as cc's: a keyword outside the subset, an object type without
// additionalProperties, and a `required` naming a non-property are schema errors; unions are accepted.
test('checkSchema rejects what cc rejects and accepts unions', () => {
  for (const kw of ['pattern', '$ref', 'oneOf']) assert.throws(() => checkSchema({ type: 'string', [kw]: 'x' }), /outside the validated subset/, kw);
  assert.throws(() => checkSchema({ type: 'object' }), /must state additionalProperties/);
  assert.throws(() => checkSchema({ type: ['object', 'null'] }), /must state additionalProperties/);
  assert.throws(() => checkSchema({ type: 'object', additionalProperties: false, required: ['a'], properties: {} }), /not a property/);
  assert.doesNotThrow(() => checkSchema({ type: ['string', 'null'] }));
  assert.doesNotThrow(() => checkSchema({ type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: ['integer', 'null'] } } }));
});

// Invariant: validate reports type, enum, required and extra-property violations and passes a valid value.
test('validate reports each kind of violation and passes valid values', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['a', 'k'], properties: { a: { type: ['string', 'null'] }, k: { type: 'string', enum: ['x', 'y'] } } };
  assert.deepEqual(validate(schema, { a: null, k: 'x' }), []);
  assert.match(validate(schema, { a: 1, k: 'x' })[0], /\$\.a: expected string\|null, got integer/);
  assert.match(validate(schema, { a: null, k: 'z' })[0], /not one of/);
  assert.match(validate(schema, { a: null })[0], /missing required 'k'/);
  assert.match(validate(schema, { a: null, k: 'x', extra: 1 })[0], /unexpected property 'extra'/);
  assert.match(validate(schema, [])[0], /expected object, got array/);
});

// Invariant (opt-in, CODE_CONDUCTOR_DIR): the port's keyword and type sets equal the ones in cc's source.
test('keyword and type sets match cc', { skip: !process.env.CODE_CONDUCTOR_DIR && 'CODE_CONDUCTOR_DIR not set' }, () => {
  const src = fs.readFileSync(path.join(process.env.CODE_CONDUCTOR_DIR, 'src/mcp/jsonSchemaSubset.ts'), 'utf8');
  const setOf = (name) => new Set([...src.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`))[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  assert.deepEqual(KEYWORDS, setOf('KEYWORDS'));
  assert.deepEqual(TYPES, setOf('TYPES'));
});
