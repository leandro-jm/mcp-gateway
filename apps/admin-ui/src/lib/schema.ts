/** Arguments skeleton built from the input schema (required fields). */
export function argsSkeleton(schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];
  const out: Record<string, unknown> = {};
  for (const k of required) {
    const p = props[k] ?? {};
    const t = Array.isArray(p.type) ? p.type[0] : p.type;
    out[k] = Array.isArray(p.enum) ? p.enum[0] : t === 'integer' || t === 'number' ? 0 : t === 'boolean' ? false : t === 'array' ? [] : t === 'object' ? {} : '';
  }
  return out;
}

export function parseJson<T = unknown>(text: string): { value?: T; error?: string } {
  try {
    return { value: JSON.parse(text) as T };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
