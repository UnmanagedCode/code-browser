import assert from 'node:assert/strict';
import { checkSchema, validate, outputSchemaOf } from './_jsonSchemaSubset.mjs';

const CODE_RE = /^[A-Z][A-Z0-9_]*$/;

// Calls a tool and asserts the reply shape cc's typed contract demands, so every call in a suite doubles as a contract check:
//   json    → exactly {structured}, valid against the manifest outputSchema;
//   text    → {text, meta?} with non-empty prose that is not a JSON object;
//   refusal → {error, code, details?} with a machine code, an error that does not repeat it, details a plain object.
export async function call(mcp, tool, args = {}, format) {
  const body = { tool, arguments: args, caller: 'test', ...(format === undefined ? {} : { format }) };
  const r = await mcp.handle(body);
  if ('error' in r) {
    assert.ok(Object.keys(r).every((k) => ['error', 'code', 'details'].includes(k)), `refusal keys: ${Object.keys(r)}`);
    assert.match(r.code, CODE_RE);
    assert.equal(typeof r.error, 'string');
    assert.ok(!r.error.startsWith(`${r.code}:`), r.error);
    if ('details' in r) assert.ok(r.details && typeof r.details === 'object' && !Array.isArray(r.details));
  } else if (format === 'json') {
    assert.deepEqual(Object.keys(r), ['structured']);
    const schema = outputSchemaOf(tool);
    checkSchema(schema);
    assert.deepEqual(validate(schema, JSON.parse(JSON.stringify(r.structured))), [], `${tool} json invalid`);
  } else {
    assert.ok(Object.keys(r).every((k) => ['text', 'meta'].includes(k)), `text keys: ${Object.keys(r)}`);
    assert.equal(typeof r.text, 'string');
    assert.ok(r.text.length > 0);
    let parsed;
    try { parsed = JSON.parse(r.text); } catch { /* prose */ }
    assert.ok(!(parsed && typeof parsed === 'object'), 'text is prose, not serialized data');
  }
  return r;
}
