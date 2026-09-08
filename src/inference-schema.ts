import Ajv, { type ValidateFunction } from 'ajv';

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function fail(message: string): never { throw Object.assign(new Error(message), { status: 400, code: 'UNSUPPORTED_JSON_SCHEMA' }); }
const annotations = new Set(['title', 'description', 'default', 'examples', '$defs', 'definitions', '$schema']);
const supported = new Set([...annotations, 'type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'enum', 'const', 'minimum', 'maximum', 'minLength', 'maxLength', '$ref', 'anyOf']);

// Match the pinned llama.cpp grammar subset. Fail closed where its converter ignores constraints.
export function compileResponseSchema(format: unknown): ValidateFunction | undefined {
  if (format === undefined) return;
  if (!object(format) || !['text', 'json_object', 'json_schema'].includes(String(format.type))) fail('Invalid response_format.');
  if (format.type === 'text') return;
  const schema = format.type === 'json_schema' ? (object(format.json_schema) ? format.json_schema.schema : format.schema) : format.schema;
  if (schema === undefined && format.type === 'json_object') return;
  if (!object(schema)) fail('response_format requires a JSON Schema object.');
  if (JSON.stringify(schema).length > 65536) fail('JSON Schema exceeds 64 KiB.');
  let nodes = 0;
  const visit = (s: unknown, depth: number): void => {
    if (!object(s) || depth > 24 || ++nodes > 1024) fail('Schema must use objects, at most 24 levels and 1024 schema nodes.');
    for (const key of Object.keys(s)) if (!supported.has(key)) fail(`Unsupported JSON Schema keyword: ${key}.`);
    const constraints = Object.keys(s).filter(k => !annotations.has(k));
    if (s.$ref !== undefined) {
      if (typeof s.$ref !== 'string' || !/^#\/(\$defs|definitions)\/[^/]+$/.test(s.$ref) || constraints.length !== 1) fail('Only local $defs/definitions references without sibling constraints are supported.');
      const parts = s.$ref.slice(2).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
      const defs = schema[parts[0]!];
      if (!object(defs) || !Object.hasOwn(defs, parts[1]!)) fail('Unresolved local schema reference.');
      visit(defs[parts[1]!], depth + 1);
      return;
    }
    if (s.anyOf !== undefined) {
      if (constraints.length !== 1 || !Array.isArray(s.anyOf) || !s.anyOf.length) fail('anyOf must be a nonempty array without sibling constraints.');
      s.anyOf.forEach(v => visit(v, depth + 1));
      return;
    }
    if (s.enum !== undefined || s.const !== undefined) {
      if (constraints.some(k => !['enum', 'const', 'type'].includes(k)) || (s.enum !== undefined && s.const !== undefined)) fail('enum/const cannot be combined with other constraints except type.');
    } else {
      if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(s.type))) fail('Each schema node needs a single explicit type, $ref, enum, const, or anyOf.');
      if (s.type === 'object') {
        if (s.properties !== undefined && !object(s.properties)) fail('properties must be an object.');
        if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some(k => typeof k !== 'string' || !object(s.properties) || !Object.hasOwn(s.properties, k)))) fail('required must name declared properties.');
        if (object(s.properties)) Object.values(s.properties).forEach(v => visit(v, depth + 1));
        if (object(s.additionalProperties)) visit(s.additionalProperties, depth + 1);
      }
      if (s.type === 'array') visit(s.items, depth + 1);
      for (const [min, max, type] of [['minItems', 'maxItems', 'array'], ['minLength', 'maxLength', 'string'], ['minimum', 'maximum', 'integer']] as const) {
        for (const key of [min, max]) if (s[key] !== undefined && (s.type !== type || !Number.isSafeInteger(s[key]) || (type !== 'integer' && (Number(s[key]) < 0 || Number(s[key]) > 32768)))) fail(`${key} is unsupported for this type or value.`);
        if (s[min] !== undefined && s[max] !== undefined && Number(s[min]) > Number(s[max])) fail(`${min} exceeds ${max}.`);
      }
    }
    for (const key of ['$defs', 'definitions']) if (s[key] !== undefined) {
      if (!object(s[key])) fail(`${key} must be an object.`);
      Object.values(s[key]).forEach(v => visit(v, depth + 1));
    }
  };
  visit(schema, 0);
  try {
    // No global cache of caller schemas/prompts; no coercion or removal of properties.
    return new Ajv({ strict: true, strictTypes: false, strictTuples: false, validateFormats: false }).compile(schema);
  } catch { return fail('Invalid or unsupported JSON Schema.'); }
}
