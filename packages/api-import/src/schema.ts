import { inferSchema, type JsonSchema } from '@mcp-gateway/openapi-toolgen';
import { MAX_INFERRED_NODES, MAX_SAMPLES } from './types';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Schema of a scalar seen as text (query, path, header or form value). */
export function inferScalar(value: string): JsonSchema {
  if (/^-?(0|[1-9]\d{0,14})$/.test(value)) return { type: 'integer' };
  if (/^-?(0|[1-9]\d*)\.\d+$/.test(value)) return { type: 'number' };
  if (value === 'true' || value === 'false') return { type: 'boolean' };
  return inferSchema(value);
}

/** Merges scalar schemas: same schema stays, integer + number is number, anything else is string. */
export function mergeScalars(schemas: JsonSchema[]): JsonSchema {
  if (!schemas.length) return { type: 'string' };
  const first = JSON.stringify(schemas[0]);
  if (schemas.every((s) => JSON.stringify(s) === first)) return schemas[0]!;
  if (schemas.every((s) => s.type === 'integer' || s.type === 'number')) return { type: 'number' };
  return { type: 'string' };
}

/**
 * Schema inferred from JSON samples. Values are never kept: only types and formats. Properties present
 * in every object sample become `required` once there are at least two samples.
 */
export function inferFromSamples(samples: unknown[]): JsonSchema {
  const used = samples.slice(0, MAX_SAMPLES);
  const schema = used.length === 1 ? inferSchema(used[0]) : ((inferSchema(used).items as JsonSchema | undefined) ?? {});
  const objects = used.filter(isObj);
  if (objects.length >= 2 && objects.length === used.length && schema.type === 'object') {
    const required = Object.keys(objects[0]!).filter((k) => objects.every((o) => k in o));
    if (required.length) return { ...schema, required };
  }
  return schema;
}

/** Cuts a schema to `max` nodes; deeper subtrees become `{}`. */
export function capSchema(schema: JsonSchema, max = MAX_INFERRED_NODES): { schema: JsonSchema; truncated: boolean } {
  const budget = { left: max, truncated: false };
  const walk = (s: JsonSchema): JsonSchema => {
    if (budget.left-- <= 0) {
      budget.truncated = true;
      return {};
    }
    const out: JsonSchema = { ...s };
    if (isObj(s.properties)) {
      out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, walk(v as JsonSchema)]));
    }
    if (isObj(s.items)) out.items = walk(s.items as JsonSchema);
    return out;
  };
  const result = walk(schema);
  return { schema: result, truncated: budget.truncated };
}
