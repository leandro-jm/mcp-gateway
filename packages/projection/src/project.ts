import type { Locale } from '@mcp-gateway/i18n';
import { msg, translate } from '@mcp-gateway/i18n/server';
import { matchPath, parseSelector, type Seg } from './selectors';

export interface ProjectionSpec {
  include?: string[];
  exclude?: string[];
  maxArrayItems?: number | null;
  maxBytes?: number | null;
}

export interface ProjectionMeta {
  truncated: true;
  /** Truncated arrays: path → original total and how many were returned. */
  arrays?: Record<string, { total: number; returned: number }>;
  /** The byte cut (`max_bytes`) was applied. */
  maxBytes?: number;
}

export interface ProjectionResult<T = unknown> {
  value: T;
  bytesBefore: number;
  bytesAfter: number;
  meta?: ProjectionMeta;
}

const SKIP = Symbol('skip');
const META_RESERVE = 512;

export const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? '');

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function formatPath(path: Seg[]): string {
  return `$${path.map((s) => (typeof s === 'number' ? `[${s}]` : /^[A-Za-z_$][\w$]*$/.test(s) ? `.${s}` : `['${s}']`)).join('')}`;
}

/** Keeps only what some `include` selector reaches. */
function applyInclude(value: unknown, path: Seg[], selectors: ReturnType<typeof parseSelector>[]): unknown | typeof SKIP {
  let prefix = false;
  for (const s of selectors) {
    const m = matchPath(s, path);
    if (m === 'full') return value;
    if (m === 'prefix') prefix = true;
  }
  if (!prefix) return SKIP;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    value.forEach((item, i) => {
      const r = applyInclude(item, [...path, i], selectors);
      if (r !== SKIP) out.push(r);
    });
    return out;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = applyInclude(v, [...path, k], selectors);
      if (r !== SKIP) out[k] = r;
    }
    return out;
  }
  return SKIP;
}

/** Removes what some `exclude` selector reaches. */
function applyExclude(value: unknown, path: Seg[], selectors: ReturnType<typeof parseSelector>[]): unknown | typeof SKIP {
  if (path.length && selectors.some((s) => matchPath(s, path) === 'full')) return SKIP;
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => {
      const r = applyExclude(item, [...path, i], selectors);
      return r === SKIP ? [] : [r];
    });
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = applyExclude(v, [...path, k], selectors);
      if (r !== SKIP) out[k] = r;
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- agent _fields

export const FIELD_RE = /^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$/;

/** Selects dotted fields preserving the structure (arrays along the path are mapped). */
function pickFields(record: unknown, fields: string[][]): unknown {
  if (Array.isArray(record)) return record.map((r) => pickFields(r, fields));
  if (!isPlainObject(record)) return record;
  const groups = new Map<string, string[][]>();
  for (const [head, ...rest] of fields) {
    if (!head) continue;
    const g = groups.get(head) ?? [];
    g.push(rest);
    groups.set(head, g);
  }
  const out: Record<string, unknown> = {};
  for (const [head, rests] of groups) {
    if (!(head in record)) continue;
    const v = record[head];
    out[head] = rests.some((r) => r.length === 0) ? v : pickFields(v, rests);
  }
  return out;
}

/**
 * Applies `_fields` relative to the "record": elements of the root array, or of the main
 * list inside an envelope (`{ items: [...], total }` keeps `total`).
 */
export function applyFields(value: unknown, fields: string[]): unknown {
  const parsed = fields.map((f) => f.split('.'));
  if (Array.isArray(value)) return value.map((v) => pickFields(v, parsed));
  if (isPlainObject(value)) {
    const listKey = Object.keys(value).find((k) => Array.isArray(value[k]) && (value[k] as unknown[]).some(isPlainObject));
    if (!listKey) return pickFields(value, parsed);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === listKey) out[k] = (v as unknown[]).map((x) => pickFields(x, parsed));
      else if (!isPlainObject(v) && !Array.isArray(v)) out[k] = v;
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- truncation

function truncateArrays(value: unknown, max: number, path: Seg[], meta: Record<string, { total: number; returned: number }>): unknown {
  if (Array.isArray(value)) {
    const kept = value.length > max ? value.slice(0, max) : value;
    if (value.length > max) meta[formatPath(path)] = { total: value.length, returned: max };
    return kept.map((v, i) => truncateArrays(v, max, [...path, i], meta));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateArrays(v, max, [...path, k], meta)]));
  }
  return value;
}

interface Candidate {
  path: Seg[];
  size: number;
  kind: 'array' | 'string';
}

function largest(value: unknown, path: Seg[] = [], best: Candidate | undefined = undefined): Candidate | undefined {
  if (Array.isArray(value)) {
    if (value.length > 1) {
      const size = bytesOf(value);
      if (!best || size > best.size) best = { path, size, kind: 'array' };
    }
    value.forEach((v, i) => (best = largest(v, [...path, i], best)));
  } else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) best = largest(v, [...path, k], best);
  } else if (typeof value === 'string' && value.length > 64) {
    const size = Buffer.byteLength(value);
    if (!best || size > best.size) best = { path, size, kind: 'string' };
  }
  return best;
}

function getAt(value: unknown, path: Seg[]): unknown {
  return path.reduce<unknown>((acc, s) => (acc as Record<string | number, unknown>)[s], value);
}

function setAt(value: unknown, path: Seg[], next: unknown): unknown {
  if (!path.length) return next;
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    const copy = [...value];
    copy[head as number] = setAt(copy[head as number], rest, next);
    return copy;
  }
  const obj = value as Record<string, unknown>;
  return { ...obj, [head as string]: setAt(obj[head as string], rest, next) };
}

/** Shrinks the value until it fits in `maxBytes` by cutting arrays and strings; never produces invalid JSON. */
function shrinkToBytes(
  value: unknown,
  maxBytes: number,
  arrays: Record<string, { total: number; returned: number }>,
  originalLengths: Map<string, number>,
): unknown {
  let v = value;
  for (let i = 0; i < 60 && bytesOf(v) > maxBytes; i++) {
    const c = largest(v);
    if (!c) break;
    const target = getAt(v, c.path);
    if (c.kind === 'array') {
      const arr = target as unknown[];
      const key = formatPath(c.path);
      const total = arrays[key]?.total ?? originalLengths.get(key) ?? arr.length;
      const keep = Math.max(1, Math.floor(arr.length / 2));
      arrays[key] = { total, returned: keep };
      v = setAt(v, c.path, arr.slice(0, keep));
    } else {
      const s = target as string;
      v = setAt(v, c.path, `${s.slice(0, Math.max(32, Math.floor(s.length / 2)))}…`);
    }
  }
  return v;
}

function recordLengths(value: unknown, path: Seg[] = [], out = new Map<string, number>()): Map<string, number> {
  if (Array.isArray(value)) {
    out.set(formatPath(path), value.length);
    value.forEach((v, i) => recordLengths(v, [...path, i], out));
  } else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) recordLengths(v, [...path, k], out);
  }
  return out;
}

/**
 * Projects a response (PLAN F6.1): `include` → `exclude` → agent `_fields` →
 * `max_array_items` → `max_bytes`. Truncation metadata goes in `_meta` at the root.
 * `locale` is the language of the human-readable `_meta.note` (default `en`).
 */
export function project<T = unknown>(value: T, spec: ProjectionSpec, opts: { fields?: string[]; locale?: Locale } = {}): ProjectionResult {
  const bytesBefore = bytesOf(value);
  let v: unknown = value;
  if (spec.include?.length) {
    const r = applyInclude(v, [], spec.include.map(parseSelector));
    v = r === SKIP ? (Array.isArray(value) ? [] : {}) : r;
  }
  if (spec.exclude?.length) {
    const r = applyExclude(v, [], spec.exclude.map(parseSelector));
    v = r === SKIP ? {} : r;
  }
  if (opts.fields?.length) v = applyFields(v, opts.fields);

  const arrays: Record<string, { total: number; returned: number }> = {};
  if (spec.maxArrayItems && spec.maxArrayItems > 0) v = truncateArrays(v, spec.maxArrayItems, [], arrays);
  let maxBytesApplied: number | undefined;
  if (spec.maxBytes && spec.maxBytes > 0 && bytesOf(v) > spec.maxBytes) {
    maxBytesApplied = spec.maxBytes;
    v = shrinkToBytes(v, Math.max(spec.maxBytes - META_RESERVE, 64), arrays, recordLengths(v));
  }

  let meta: ProjectionMeta | undefined;
  if (Object.keys(arrays).length || maxBytesApplied) {
    meta = { truncated: true, ...(Object.keys(arrays).length ? { arrays } : {}), ...(maxBytesApplied ? { maxBytes: maxBytesApplied } : {}) };
    if (isPlainObject(v)) v = { ...v, _meta: meta };
  }
  if (maxBytesApplied && bytesOf(v) > maxBytesApplied) {
    v = { _meta: { ...meta, truncated: true, note: translate(msg('projection.stillExceedsMaxBytes', { maxBytes: maxBytesApplied }), opts.locale) } };
  }
  return { value: v, bytesBefore, bytesAfter: bytesOf(v), ...(meta ? { meta } : {}) };
}
