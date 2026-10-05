import type { JsonSchema } from './normalize';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

function mergeTypes(a: JsonSchema, b: JsonSchema): JsonSchema {
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  if (a.type === 'object' && b.type === 'object') {
    const props: Record<string, JsonSchema> = { ...(a.properties as Record<string, JsonSchema>) };
    for (const [k, v] of Object.entries(b.properties as Record<string, JsonSchema>)) props[k] = props[k] ? mergeTypes(props[k]!, v) : v;
    return { type: 'object', properties: props };
  }
  if (a.type === 'array' && b.type === 'array') return { type: 'array', items: mergeTypes(a.items as JsonSchema, b.items as JsonSchema) };
  if ((a.type === 'integer' && b.type === 'number') || (a.type === 'number' && b.type === 'integer')) return { type: 'number' };
  const types = new Set([...[a.type].flat(), ...[b.type].flat()].filter(Boolean) as string[]);
  return { type: [...types] };
}

/** Infers a JSON Schema from a sample response (manual tools, F7b.1). */
export function inferSchema(example: unknown): JsonSchema {
  if (example === null) return { type: 'null' };
  if (Array.isArray(example)) {
    if (!example.length) return { type: 'array', items: {} };
    return { type: 'array', items: example.slice(0, 50).map(inferSchema).reduce(mergeTypes) };
  }
  switch (typeof example) {
    case 'string':
      return DATETIME_RE.test(example) ? { type: 'string', format: 'date-time' } : DATE_RE.test(example) ? { type: 'string', format: 'date' } : { type: 'string' };
    case 'number':
      return Number.isInteger(example) ? { type: 'integer' } : { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object':
      return {
        type: 'object',
        properties: Object.fromEntries(Object.entries(example as Record<string, unknown>).map(([k, v]) => [k, inferSchema(v)])),
      };
    default:
      return {};
  }
}
