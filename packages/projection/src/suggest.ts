type Schema = Record<string, unknown>;
const isObj = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);
const SCALAR = new Set(['string', 'number', 'integer', 'boolean']);

function isScalar(s: Schema): boolean {
  const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
  return types.some((t) => SCALAR.has(t)) && !types.includes('object') && !types.includes('array');
}

/**
 * Projection suggested at crawl time (PLAN F6.2): for list responses, the first-level scalar
 * fields of the items (up to `maxFields`), plus the envelope scalars (`total`…).
 * Returns `undefined` if the tool does not return a list.
 */
export function suggestProjection(outputSchema: Schema | null, maxFields = 8): { include: string[] } | undefined {
  if (!outputSchema || !isObj(outputSchema.properties)) return undefined;
  for (const [key, prop] of Object.entries(outputSchema.properties)) {
    if (!isObj(prop) || prop.type !== 'array' || !isObj(prop.items) || !isObj(prop.items.properties)) continue;
    const fields = Object.entries(prop.items.properties)
      .filter(([, s]) => isObj(s) && isScalar(s))
      .slice(0, maxFields)
      .map(([f]) => `$.${key}[*].${f}`);
    if (!fields.length) return undefined;
    const envelope = Object.entries(outputSchema.properties)
      .filter(([k, s]) => k !== key && isObj(s) && isScalar(s))
      .map(([k]) => `$.${k}`);
    return { include: [...fields, ...envelope] };
  }
  return undefined;
}
