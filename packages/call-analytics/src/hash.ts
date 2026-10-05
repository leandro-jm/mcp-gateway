import { createHash, createHmac } from 'node:crypto';

/** JSON with object keys sorted recursively: equal values give equal strings. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Keyed hash of the call arguments. Detects repeated calls (loops) without storing arguments;
 * the tenant key keeps it from being a dictionary oracle for low-entropy values.
 */
export function argsHash(key: Uint8Array, args: unknown): string {
  return createHmac('sha256', key).update(canonicalJson(args)).digest('hex').slice(0, 32);
}

/** Unkeyed short hash (e.g. search query fingerprint for grouping). */
export function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
