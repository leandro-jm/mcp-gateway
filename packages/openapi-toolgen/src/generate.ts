import { createHash } from 'node:crypto';
import type { BodyMapping, OperationRef, ParamMapping, ResponseMapping, ToolAnnotations } from '@mcp-gateway/core';
import type { JsonSchema, NormalizedOperation, NormalizedSpec } from './normalize';

export interface GeneratedTool {
  /** Stable `METHOD /path` key (matching across crawls). */
  operationKey: string;
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema | null;
  annotations: ToolAnnotations;
  operationRef: OperationRef;
  tags: string[];
  specHash: string;
}

export interface SkippedOperation {
  operationKey: string;
  reason: 'deprecated' | 'x-mcp-ignore';
}

export interface GenerateOptions {
  /** Source name (tool prefix). */
  sourceName: string;
  /** Maximum depth of objects/arrays in the input schema (default 5). */
  maxDepth?: number;
  /** Maximum oneOf/anyOf branches before the union becomes a description (default 4). */
  maxUnionBranches?: number;
  /**
   * Maximum length of the description shown to agents (default 1024). The generated body uses at most
   * `maxDescriptionLength - DESCRIPTION_SUFFIX_RESERVE` chars: the rest is reserved for the localized
   * effect suffix the gateway appends at `tools/list` time (ADR-012).
   */
  maxDescriptionLength?: number;
}

export interface GenerateResult {
  tools: GeneratedTool[];
  skipped: SkippedOperation[];
}

const MAX_NAME = 64;

const VERBS = new Set([
  'list',
  'get',
  'create',
  'update',
  'delete',
  'patch',
  'search',
  'find',
  'add',
  'remove',
  'set',
  'upsert',
  'count',
  'export',
  'import',
  'send',
  'cancel',
  'approve',
  'reject',
  'fetch',
  'retrieve',
  'register',
  'replace',
  'post',
  'put',
]);

const AUTH_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);

// ---------------------------------------------------------------- utilities

export function shortHash(input: string, len = 6): string {
  return createHash('sha256').update(input).digest('hex').slice(0, len);
}

/** camelCase / kebab / accents → ASCII snake_case. */
export function snake(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();
}

function clampName(name: string, key: string): string {
  let n = name.replace(/^[^a-z]+/, '');
  if (!n) n = `op_${shortHash(key)}`;
  if (n.length <= MAX_NAME) return n;
  return `${n.slice(0, MAX_NAME - 7).replace(/_+$/, '')}_${shortHash(key)}`;
}

/** Canonical JSON (sorted keys) for stable hashing. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Strips simple markdown/HTML and normalizes whitespace. */
export function cleanText(input: string): string {
  return input
    .replace(/<[^>]+>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- name

function operationVerb(op: NormalizedOperation): string {
  const lastIsParam = /\}$/.test(op.path.replace(/\/$/, ''));
  switch (op.method) {
    case 'GET':
      return lastIsParam ? 'get' : 'list';
    case 'POST':
      return 'create';
    case 'PUT':
      return 'update';
    case 'PATCH':
      return 'patch';
    case 'DELETE':
      return 'delete';
    default:
      return op.method.toLowerCase();
  }
}

function pathResource(path: string): string {
  return snake(
    path
      .split('/')
      .filter((s) => s && !s.startsWith('{'))
      .join('_'),
  );
}

export function baseToolName(source: string, op: NormalizedOperation): string {
  const prefix = snake(source);
  const custom = op.extensions['x-mcp-name'];
  if (typeof custom === 'string' && custom.trim()) return clampName(snake(custom), op.key);
  if (op.operationId) {
    const tokens = snake(op.operationId).split('_').filter(Boolean);
    const [first, ...rest] = tokens;
    if (first && VERBS.has(first)) {
      const resource = rest.join('_') || pathResource(op.path);
      return clampName([prefix, resource, first].filter(Boolean).join('_'), op.key);
    }
    return clampName([prefix, ...tokens].join('_'), op.key);
  }
  return clampName([prefix, pathResource(op.path) || 'root', operationVerb(op)].join('_'), op.key);
}

// ---------------------------------------------------------------- schemas

interface SchemaCtx {
  maxDepth: number;
  maxUnion: number;
}

const isObj = (v: unknown): v is JsonSchema => typeof v === 'object' && v !== null && !Array.isArray(v);

function typeLabel(s: JsonSchema): string {
  if (typeof s.title === 'string') return s.title;
  if (Array.isArray(s.enum)) return s.enum.map(String).join('/');
  if (typeof s.type === 'string') return s.type;
  if (Array.isArray(s.type)) return s.type.join('|');
  return 'object';
}

/** Merges a simple `allOf` (all objects) into a single object. */
function mergeAllOf(s: JsonSchema): JsonSchema {
  if (!Array.isArray(s.allOf)) return s;
  const branches = s.allOf.filter(isObj);
  const allObjects = branches.every((b) => b.type === 'object' || isObj(b.properties) || Array.isArray(b.allOf));
  if (!allObjects) return s;
  const { allOf: _a, ...rest } = s;
  const merged: JsonSchema = { ...rest, type: 'object', properties: {} };
  const required = new Set<string>(Array.isArray(s.required) ? (s.required as string[]) : []);
  for (const raw of branches) {
    const b = mergeAllOf(raw);
    Object.assign(merged.properties as JsonSchema, isObj(b.properties) ? b.properties : {});
    for (const r of Array.isArray(b.required) ? (b.required as string[]) : []) required.add(r);
    if (!merged.description && typeof b.description === 'string') merged.description = b.description;
  }
  if (isObj(rest.properties)) Object.assign(merged.properties as JsonSchema, rest.properties);
  if (required.size) merged.required = [...required];
  return merged;
}

function schemaDepth(s: JsonSchema, depth = 0): number {
  let max = depth;
  if (isObj(s.properties)) {
    for (const p of Object.values(s.properties)) if (isObj(p)) max = Math.max(max, schemaDepth(p, depth + 1));
  }
  if (isObj(s.items)) max = Math.max(max, schemaDepth(s.items, depth + 1));
  for (const k of ['oneOf', 'anyOf'] as const) {
    if (Array.isArray(s[k])) for (const b of s[k] as unknown[]) if (isObj(b)) max = Math.max(max, schemaDepth(b, depth));
  }
  return max;
}

/**
 * Simplifies a schema for agents: resolves `allOf`, cuts depth, replaces complex unions with a
 * description and circular references with a placeholder. Generated texts are fixed English (ADR-012):
 * they are persisted data read by LLMs.
 */
export function simplifySchema(input: JsonSchema, ctx: SchemaCtx, depth = 1, dropReadOnly = false): JsonSchema {
  let s = mergeAllOf(input);
  if (typeof s.$ref === 'string') {
    return { type: 'object', description: 'Recursive structure (details omitted)' };
  }
  for (const k of ['oneOf', 'anyOf'] as const) {
    const branches = s[k];
    if (!Array.isArray(branches)) continue;
    const tooMany = branches.length > ctx.maxUnion;
    const tooDeep = branches.some((b) => isObj(b) && depth + schemaDepth(b) > ctx.maxDepth);
    if (tooMany || tooDeep) {
      const { [k]: _u, ...rest } = s;
      const labels = branches.filter(isObj).map(typeLabel).join(' | ');
      const desc = [typeof rest.description === 'string' ? rest.description : '', `Accepts one of: ${labels}.`]
        .filter(Boolean)
        .join(' ');
      return { ...rest, description: desc };
    }
    s = { ...s, [k]: branches.map((b) => (isObj(b) ? simplifySchema(b, ctx, depth, dropReadOnly) : b)) };
  }

  const isContainer = s.type === 'object' || isObj(s.properties) || s.type === 'array' || isObj(s.items);
  if (isContainer && depth > ctx.maxDepth) {
    const type = s.type ?? (isObj(s.items) ? 'array' : 'object');
    const desc = [typeof s.description === 'string' ? s.description : '', '(nested structure omitted)']
      .filter(Boolean)
      .join(' ');
    return { type, description: desc };
  }

  const out: JsonSchema = { ...s };
  if (isObj(s.properties)) {
    const props: JsonSchema = {};
    for (const [name, p] of Object.entries(s.properties)) {
      if (!isObj(p)) continue;
      if (dropReadOnly && p.readOnly === true) continue;
      props[name] = simplifySchema(p, ctx, depth + 1, dropReadOnly);
    }
    out.properties = props;
    if (Array.isArray(s.required)) {
      const req = (s.required as string[]).filter((r) => r in props);
      if (req.length) out.required = req;
      else delete out.required;
    }
  }
  if (isObj(s.items)) out.items = simplifySchema(s.items, ctx, depth + 1, dropReadOnly);
  if (isObj(s.additionalProperties)) {
    out.additionalProperties = simplifySchema(s.additionalProperties, ctx, depth + 1, dropReadOnly);
  }
  if (dropReadOnly) delete out.readOnly;
  return out;
}

// ---------------------------------------------------------------- input

function fieldName(name: string, location: string): string {
  if (location === 'header') return snake(name);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : snake(name) || `p_${shortHash(name, 4)}`;
}

interface InputBuild {
  schema: JsonSchema;
  params: ParamMapping[];
  body?: BodyMapping;
}

function authParamNames(spec: NormalizedSpec): { headers: Set<string>; query: Set<string> } {
  const headers = new Set(AUTH_HEADERS);
  const query = new Set<string>();
  for (const s of Object.values(spec.securitySchemes)) {
    if (s.type === 'apiKey' && s.name) (s.in === 'query' ? query : headers).add(s.name.toLowerCase());
  }
  return { headers, query };
}

function buildInput(spec: NormalizedSpec, op: NormalizedOperation, ctx: SchemaCtx): InputBuild {
  const auth = authParamNames(spec);
  const properties: JsonSchema = {};
  const required: string[] = [];
  const params: ParamMapping[] = [];

  const ordered = [...op.parameters].sort(
    (a, b) => ['path', 'query', 'header'].indexOf(a.in) - ['path', 'query', 'header'].indexOf(b.in),
  );
  for (const p of ordered) {
    if (p.in === 'cookie') continue;
    if (p.in === 'header' && auth.headers.has(p.name.toLowerCase())) continue;
    if (p.in === 'query' && auth.query.has(p.name.toLowerCase())) continue;
    let field = fieldName(p.name, p.in);
    if (field in properties) field = `${field}_${p.in}`;
    const schema = simplifySchema(p.schema, ctx, 2);
    if (p.description && !schema.description) schema.description = cleanText(p.description);
    properties[field] = schema;
    if (p.required) required.push(field);
    params.push({
      field,
      in: p.in as ParamMapping['in'],
      name: p.name,
      ...(p.explode !== undefined ? { explode: p.explode } : {}),
    });
  }

  let body: BodyMapping | undefined;
  const rb = op.requestBody;
  if (rb) {
    const bodySchema = simplifySchema(rb.schema, ctx, 1, true);
    const props = isObj(bodySchema.properties) ? bodySchema.properties : undefined;
    const collides = props ? Object.keys(props).some((k) => k in properties) : true;
    const isObject = bodySchema.type === 'object' || props !== undefined;
    if (isObject && props && !collides && Object.keys(props).length > 0) {
      for (const [k, v] of Object.entries(props)) properties[k] = v;
      if (rb.required && Array.isArray(bodySchema.required)) required.push(...(bodySchema.required as string[]));
      body = { mode: 'flatten', fields: Object.keys(props), contentType: rb.contentType };
    } else {
      let field = 'body';
      while (field in properties) field = `_${field}`;
      const nested = simplifySchema(rb.schema, ctx, 2, true);
      if (rb.description && !nested.description) nested.description = cleanText(rb.description);
      properties[field] = nested;
      if (rb.required) required.push(field);
      body = { mode: 'field', field, contentType: rb.contentType };
    }
  }

  return {
    schema: {
      type: 'object',
      properties,
      ...(required.length ? { required: [...new Set(required)] } : {}),
      additionalProperties: false,
    },
    params,
    ...(body ? { body } : {}),
  };
}

// ---------------------------------------------------------------- output

function buildOutput(op: NormalizedOperation): { schema: JsonSchema | null; response: ResponseMapping } {
  const ok = op.responses.filter((r) => /^2\d\d$/.test(r.status) || r.status === '2XX');
  const main =
    ok.find((r) => r.status === '200' && r.schema) ??
    ok.find((r) => r.status === '201' && r.schema) ??
    ok.find((r) => r.schema) ??
    ok[0];
  if (!main?.schema) return { schema: null, response: main?.contentType ? { contentType: main.contentType } : {} };
  const ctx = { maxDepth: 12, maxUnion: 12 };
  const schema = simplifySchema(main.schema, ctx, 1);
  const base = main.contentType ? { contentType: main.contentType } : {};
  const isObject = schema.type === 'object' || isObj(schema.properties);
  if (isObject) return { schema, response: base };
  const wrap = schema.type === 'array' || isObj(schema.items) ? 'items' : 'value';
  return {
    schema: { type: 'object', properties: { [wrap]: schema }, required: [wrap] },
    response: { ...base, wrap },
  };
}

// ---------------------------------------------------------------- description and annotations

export function annotationsFor(method: string): ToolAnnotations {
  switch (method) {
    case 'GET':
    case 'HEAD':
      return { readOnlyHint: true };
    case 'DELETE':
      return { readOnlyHint: false, destructiveHint: true };
    case 'PUT':
      return { readOnlyHint: false, idempotentHint: true };
    default:
      return { readOnlyHint: false };
  }
}

/**
 * Chars of `maxDescriptionLength` reserved for the effect suffix ("Read-only.", "Modifies data
 * (destructive operation)."…) that the gateway appends, localized, at `tools/list` time from the
 * annotations. Covers the longest suffix in any locale plus the separating space.
 */
export const DESCRIPTION_SUFFIX_RESERVE = 40;

/** Tool description without the effect suffix (no longer persisted, ADR-012). */
function buildDescription(op: NormalizedOperation, max: number): string {
  const custom = op.extensions['x-mcp-description'];
  let body: string;
  if (typeof custom === 'string' && custom.trim()) {
    body = cleanText(custom);
  } else {
    const summary = op.summary ? cleanText(op.summary) : '';
    const description = op.description ? cleanText(op.description) : '';
    const parts = [summary];
    if (description && description !== summary) parts.push(description);
    body = parts.filter(Boolean).join('. ').replace(/\.\./g, '.');
    if (!body) body = `${op.method} ${op.path}`;
  }
  if (!/[.!?]$/.test(body)) body += '.';
  const room = max - DESCRIPTION_SUFFIX_RESERVE;
  if (body.length > room) body = `${body.slice(0, room - 1).trimEnd()}…`;
  return body;
}

// ---------------------------------------------------------------- API

export function generateTools(spec: NormalizedSpec, opts: GenerateOptions): GenerateResult {
  const ctx: SchemaCtx = { maxDepth: opts.maxDepth ?? 5, maxUnion: opts.maxUnionBranches ?? 4 };
  const maxDesc = opts.maxDescriptionLength ?? 1024;
  const tools: GeneratedTool[] = [];
  const skipped: SkippedOperation[] = [];
  const used = new Set<string>();

  // Stable order: collision resolution does not depend on the spec order.
  const ops = [...spec.operations].sort((a, b) => a.key.localeCompare(b.key));
  for (const op of ops) {
    if (op.extensions['x-mcp-ignore'] === true) {
      skipped.push({ operationKey: op.key, reason: 'x-mcp-ignore' });
      continue;
    }
    if (op.deprecated) {
      skipped.push({ operationKey: op.key, reason: 'deprecated' });
      continue;
    }
    let name = baseToolName(opts.sourceName, op);
    if (used.has(name)) name = clampName(`${name.slice(0, MAX_NAME - 7)}_${shortHash(op.key)}`, op.key);
    used.add(name);

    const annotations = annotationsFor(op.method);
    const input = buildInput(spec, op, ctx);
    const output = buildOutput(op);
    const operationRef: OperationRef = {
      method: op.method,
      path: op.path,
      ...(op.operationId ? { operationId: op.operationId } : {}),
      mapping: {
        params: input.params,
        ...(input.body ? { body: input.body } : {}),
        response: output.response,
      },
    };
    const tool: Omit<GeneratedTool, 'specHash'> = {
      operationKey: op.key,
      name,
      title: op.summary ? cleanText(op.summary) : name,
      description: buildDescription(op, maxDesc),
      inputSchema: input.schema,
      outputSchema: output.schema,
      annotations,
      operationRef,
      tags: op.tags,
    };
    tools.push({ ...tool, specHash: createHash('sha256').update(canonicalJson(tool)).digest('hex') });
  }
  return { tools, skipped };
}
