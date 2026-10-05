import { msg, type ServerMessage } from '@mcp-gateway/i18n/server';
import type { OpenApiDocument } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export type MergeMode = 'add' | 'replace';

export interface MergeResult {
  doc: OpenApiDocument;
  added: string[];
  replaced: string[];
  /** Operations already present and kept (mode `add`). */
  conflicts: string[];
  warnings: ServerMessage[];
}

/** `METHOD /path` keys of every operation in an OpenAPI document. */
export function operationKeys(doc: OpenApiDocument): string[] {
  const paths = isObj(doc.paths) ? doc.paths : {};
  return Object.entries(paths).flatMap(([path, item]) =>
    isObj(item) ? METHODS.filter((m) => isObj(item[m])).map((m) => `${m.toUpperCase()} ${path}`) : [],
  );
}

/** Keeps only the selected operations (`include` holds `METHOD /path` keys). */
export function filterOperations(doc: OpenApiDocument, include: readonly string[]): OpenApiDocument {
  const keep = new Set(include);
  const paths: Obj = {};
  for (const [path, item] of Object.entries(isObj(doc.paths) ? doc.paths : {})) {
    if (!isObj(item)) continue;
    const next: Obj = {};
    for (const [k, v] of Object.entries(item)) {
      const isOp = (METHODS as readonly string[]).includes(k);
      if (!isOp || keep.has(`${k.toUpperCase()} ${path}`)) next[k] = v;
    }
    if (METHODS.some((m) => isObj(next[m]))) paths[path] = next;
  }
  return { ...doc, paths };
}

/** Same-named entries keep the base version, unless `replace`; new ones are appended. */
function mergeRecord(base: unknown, incoming: unknown, replace: boolean): Obj | undefined {
  if (!isObj(base) && !isObj(incoming)) return undefined;
  return replace ? { ...(isObj(base) ? base : {}), ...(isObj(incoming) ? incoming : {}) } : { ...(isObj(incoming) ? incoming : {}), ...(isObj(base) ? base : {}) };
}

/**
 * Merges the operations of `incoming` into `base` by `METHOD path` (ADR-014 §4). `add` keeps existing
 * operations and reports them as conflicts; `replace` overwrites them. `include` selects operations
 * of `incoming`. Components and security schemes are merged with the same precedence; base `info`
 * and `servers` are kept.
 */
export function mergeOpenApi(base: OpenApiDocument, incoming: OpenApiDocument, mode: MergeMode, include?: readonly string[]): MergeResult {
  const source = include ? filterOperations(incoming, include) : incoming;
  const replace = mode === 'replace';
  const paths: Obj = structuredClone(isObj(base.paths) ? base.paths : {});
  const added: string[] = [];
  const replaced: string[] = [];
  const conflicts: string[] = [];
  const warnings: ServerMessage[] = [];

  for (const [path, item] of Object.entries(isObj(source.paths) ? source.paths : {})) {
    if (!isObj(item)) continue;
    const target: Obj = isObj(paths[path]) ? (paths[path] as Obj) : {};
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const key = `${method.toUpperCase()} ${path}`;
      if (!isObj(target[method])) {
        target[method] = op;
        added.push(key);
      } else if (replace) {
        target[method] = op;
        replaced.push(key);
      } else {
        conflicts.push(key);
        warnings.push(msg('import.mergeConflict', { operation: key }));
      }
    }
    if (METHODS.some((m) => isObj(target[m]))) paths[path] = target;
  }

  const baseComponents = isObj(base.components) ? base.components : {};
  const incomingComponents = isObj(source.components) ? source.components : {};
  const components: Obj = { ...baseComponents };
  for (const section of new Set([...Object.keys(baseComponents), ...Object.keys(incomingComponents)])) {
    const merged = mergeRecord(baseComponents[section], incomingComponents[section], replace);
    if (merged) components[section] = merged;
  }

  const security = [...(Array.isArray(base.security) ? base.security : [])];
  for (const req of Array.isArray(source.security) ? source.security : []) {
    if (!security.some((s) => JSON.stringify(s) === JSON.stringify(req))) security.push(req);
  }

  const doc: OpenApiDocument = { ...base, paths };
  if (Object.keys(components).length) doc.components = components;
  if (security.length) doc.security = security;
  return { doc, added, replaced, conflicts, warnings };
}

/**
 * Makes generated paths relative to the chosen base URL: with `https://h.io/v1`, `/v1/users` becomes
 * `/users`. Paths outside the prefix are kept; on collision the first one wins.
 */
export function rebasePaths(doc: OpenApiDocument, baseUrl: string): OpenApiDocument {
  let prefix: string;
  try {
    prefix = new URL(baseUrl).pathname.replace(/\/+$/, '');
  } catch {
    return doc;
  }
  if (!prefix) return doc;
  const paths: Obj = {};
  for (const [path, item] of Object.entries(isObj(doc.paths) ? doc.paths : {})) {
    const next = path === prefix ? '/' : path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path;
    paths[next] ??= item;
  }
  return { ...doc, paths, servers: [{ url: baseUrl.replace(/\/+$/, '') }] };
}
