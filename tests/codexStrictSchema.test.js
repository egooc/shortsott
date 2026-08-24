const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { toCodexStrictSchema, codexSchemaPath } = require('../server/services/gptMidformCliService');

// OpenAI structured outputs rejects a schema where a key in `properties` is absent from
// `required`. Our shared schemas mark genuinely optional fields, so they need translating rather
// than editing - the contract is shared with Vertex and with the validators.
test('every property becomes required', () => {
  const out = toCodexStrictSchema({
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'array', items: { type: 'string' } } },
    required: ['a']
  });
  assert.deepEqual(out.required, ['a', 'b']);
});

test('a field that was optional becomes nullable, so absence is still expressible', () => {
  const out = toCodexStrictSchema({
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'array', items: { type: 'string' } } },
    required: ['a']
  });
  assert.equal(out.properties.a.type, 'string', 'a was required and keeps its plain type');
  assert.deepEqual(out.properties.b.type, ['array', 'null']);
});

test('additionalProperties is closed on every object', () => {
  const out = toCodexStrictSchema({
    type: 'object',
    properties: { nested: { type: 'object', properties: { x: { type: 'string' } }, required: [] } },
    required: ['nested']
  });
  assert.equal(out.additionalProperties, false);
  assert.equal(out.properties.nested.additionalProperties, false);
  assert.deepEqual(out.properties.nested.required, ['x']);
});

test('array items are translated too', () => {
  const out = toCodexStrictSchema({
    type: 'object',
    properties: {
      rows: { type: 'array', items: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a'] } }
    },
    required: ['rows']
  });
  assert.deepEqual(out.properties.rows.items.required, ['a', 'b']);
  assert.deepEqual(out.properties.rows.items.properties.b.type, ['string', 'null']);
});

test('$schema and $id are dropped - strict mode has no use for them', () => {
  const out = toCodexStrictSchema({ $schema: 'x', $id: 'y', type: 'object', properties: {}, required: [] });
  assert.equal(out.$schema, undefined);
  assert.equal(out.$id, undefined);
});

// The real one: this is the schema that actually failed against Codex.
test('the slot_fills schema translates to something strict mode accepts', () => {
  const target = codexSchemaPath('midform/schemas/midform_slot_fills_schema.json');
  const doc = JSON.parse(fs.readFileSync(target, 'utf8'));
  const item = doc.properties.slot_fills.items;
  assert.ok(item.required.includes('caption_kr_dialogue'), 'the field Codex complained about is now required');
  assert.equal(item.additionalProperties, false);
  // ...and still optional in effect.
  assert.ok(Array.isArray(item.properties.caption_kr_dialogue.type));
  assert.ok(item.properties.caption_kr_dialogue.type.includes('null'));
});

test('translation is idempotent - a second pass changes nothing', () => {
  const once = toCodexStrictSchema({
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'string' } },
    required: ['a']
  });
  assert.deepEqual(toCodexStrictSchema(once), once);
});
