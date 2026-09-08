import { expect, test } from 'vitest';
import { compileResponseSchema } from '../src/inference-schema.js';
const compile = (schema: unknown) => compileResponseSchema({ type: 'json_schema', json_schema: { name: 'test', strict: true, schema } })!;
test('strict nested matrix, local references, enum and required constraints are checked', () => {
  const valid = compile({ type: 'object', properties: {
    matrix: { type: 'array', minItems: 2, maxItems: 2, items: { $ref: '#/$defs/row' } },
    label: { enum: ['ok'] },
  }, required: ['matrix', 'label'], additionalProperties: false,
  $defs: { row: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer', minimum: 0, maximum: 9 } } } });
  expect(valid({ matrix: [[1, 2], [3, 4]], label: 'ok' })).toBe(true);
  for (const v of [{ matrix: [[1], [2, 3]], label: 'ok' }, { matrix: [[1, 2], [3, 10]], label: 'ok' },
    { matrix: [[1, 2], [3, 4]], label: 'wrong' }, { matrix: [[1, 2], [3, 4]] }, { matrix: [[1, 2], [3, 4]], label: 'ok', extra: 1 }]) expect(valid(v)).toBe(false);
  expect(compile({ anyOf: [{ type: 'integer' }, { type: 'null' }] })(null)).toBe(true);
});
test('unsupported, recursive, contradictory and remote constraints are rejected instead of ignored', () => {
  for (const schema of [{ type: 'number', minimum: 0 }, { oneOf: [{ type: 'number' }, { type: 'integer' }] },
    { type: 'string', pattern: '^x$' }, { type: 'array', items: { type: 'integer' }, minItems: 3, maxItems: 2 },
    { $ref: 'https://private.example/schema' }, { $ref: '#/$defs/a', $defs: { a: { $ref: '#/$defs/a' } } },
    { type: 'object', required: ['missing'] }, { type: 'string', unknownKeyword: true },
    { type: 'integer', enum: [1, 2], minimum: 2 }]) expect(() => compile(schema)).toThrow();
});
