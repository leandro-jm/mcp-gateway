import SwaggerParser from '@apidevtools/swagger-parser';
import { msg, translate, type ServerMessage } from '@mcp-gateway/i18n/server';

/**
 * Normalization of Swagger 2.0, OpenAPI 3.0 and 3.1 specs into a single internal model.
 * Every schema comes out as JSON Schema (2020-12 dialect, without `nullable`/`x-nullable`).
 */

export type JsonSchema = Record<string, unknown>;
export type SpecVersion = '2.0' | '3.0' | '3.1';
export type ParamLocation = 'path' | 'query' | 'header' | 'cookie';

export interface NormalizedParameter {
  name: string;
  in: ParamLocation;
  required: boolean;
  description?: string;
  schema: JsonSchema;
  /** Query array serialization: `form` explodes (a=1&a=2) or CSV (a=1,2). */
  explode?: boolean;
}

export interface NormalizedRequestBody {
  required: boolean;
  contentType: string;
  description?: string;
  schema: JsonSchema;
}

export interface NormalizedResponse {
  status: string;
  description?: string;
  contentType?: string;
  schema?: JsonSchema;
}

export interface NormalizedSecurityScheme {
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect' | 'basic';
  in?: string;
  name?: string;
  scheme?: string;
}

export interface NormalizedOperation {
  /** Stable `METHOD /path` key. */
  key: string;
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags: string[];
  deprecated: boolean;
  /** The operation's `x-*` extensions. */
  extensions: Record<string, unknown>;
  parameters: NormalizedParameter[];
  requestBody?: NormalizedRequestBody;
  responses: NormalizedResponse[];
}

export interface NormalizedSpec {
  specVersion: SpecVersion;
  title: string;
  version: string;
  description?: string;
  servers: string[];
  securitySchemes: Record<string, NormalizedSecurityScheme>;
  operations: NormalizedOperation[];
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Invalid or unsupported spec. `message` is English (logs); `msg` is rendered in the caller's locale. */
export class SpecError extends Error {
  constructor(readonly msg: ServerMessage) {
    super(translate(msg));
    this.name = 'SpecError';
  }
}

export function detectVersion(spec: Obj): SpecVersion {
  if (typeof spec.swagger === 'string' && spec.swagger.startsWith('2.')) return '2.0';
  if (typeof spec.openapi === 'string') {
    if (spec.openapi.startsWith('3.0')) return '3.0';
    if (spec.openapi.startsWith('3.1')) return '3.1';
  }
  throw new SpecError(msg('toolgen.unsupportedSpecVersion'));
}

/**
 * Resolves internal `$ref`s. External references are forbidden (prevents SSRF and file reads).
 * Circular references stay as `$ref` and are handled during generation.
 */
export async function dereferenceSpec(spec: unknown): Promise<Obj> {
  if (!isObj(spec)) throw new SpecError(msg('toolgen.specNotObject'));
  detectVersion(spec);
  const external = findExternalRef(spec);
  if (external) throw new SpecError(msg('toolgen.externalRef', { ref: external }));
  // dereferencing copies every path to a shared schema: refuse before paying for it
  if (expandedSize(spec, MAX_EXPANDED_NODES) >= MAX_EXPANDED_NODES) throw new SpecError(msg('toolgen.schemaTooLarge', { max: MAX_EXPANDED_NODES }));
  try {
    const options = {
      resolve: { external: false, file: false, http: false },
      dereference: { circular: 'ignore' },
      validate: { schema: false, spec: false },
    } as unknown as SwaggerParser.Options;
    const result: unknown = await SwaggerParser.dereference(structuredClone(spec) as never, options);
    return result as Obj;
  } catch (err) {
    throw new SpecError(msg('toolgen.refResolveFailed', { error: (err as Error).message }));
  }
}

/** Most nodes a spec may have with its internal `$ref`s expanded (what dereferencing walks). */
export const MAX_EXPANDED_NODES = 1_000_000;

/**
 * Size of the spec with every internal `$ref` expanded, without expanding it: each target's size
 * is memoized, so the cost is linear in the spec. Circular references count once. Stops at `cap`.
 */
function expandedSize(spec: Obj, cap: number): number {
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const resolve = (ref: string): unknown =>
    ref
      .slice(2)
      .split('/')
      .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce<unknown>((acc, k) => (typeof acc === 'object' && acc !== null ? (acc as Obj)[k] : undefined), spec);
  const sizeOf = (node: unknown): number => {
    if (typeof node !== 'object' || node === null) return 1;
    const ref = (node as Obj).$ref;
    if (typeof ref === 'string' && ref.startsWith('#/')) {
      const known = memo.get(ref);
      if (known !== undefined) return known;
      if (visiting.has(ref)) return 1;
      visiting.add(ref);
      const n = sizeOf(resolve(ref));
      visiting.delete(ref);
      memo.set(ref, n);
      return n;
    }
    let n = 1;
    for (const v of Object.values(node)) {
      n += sizeOf(v);
      if (n >= cap) return cap;
    }
    return n;
  };
  return sizeOf(spec);
}

function findExternalRef(node: unknown, seen = new WeakSet<object>()): string | undefined {
  if (typeof node !== 'object' || node === null || seen.has(node)) return undefined;
  seen.add(node);
  if (!Array.isArray(node) && typeof (node as Obj).$ref === 'string' && !((node as Obj).$ref as string).startsWith('#')) {
    return (node as Obj).$ref as string;
  }
  for (const v of Object.values(node)) {
    const found = findExternalRef(v, seen);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------- schemas

const DROP_KEYS = new Set(['xml', 'externalDocs', 'discriminator', 'nullable', 'x-nullable', 'example', 'collectionFormat']);
const SCHEMA_MAP_KEYS = ['properties', 'patternProperties', '$defs', 'definitions'];
const SCHEMA_ARRAY_KEYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const SCHEMA_SINGLE_KEYS = ['items', 'additionalProperties', 'not', 'contains', 'propertyNames', 'if', 'then', 'else'];

/**
 * Most schema nodes one conversion may produce. After dereferencing, a schema reused through
 * several paths is expanded each time: 30 levels of two `$ref`s each would be 2^30 nodes.
 */
export const MAX_SCHEMA_NODES = 20_000;

/** Converts an OpenAPI schema (any version) into plain JSON Schema. */
export function toJsonSchema(schema: unknown, version: SpecVersion, seen = new WeakSet<object>(), budget = { left: MAX_SCHEMA_NODES }): JsonSchema {
  if (!isObj(schema)) return {};
  if (seen.has(schema)) return { $ref: '#circular' };
  if (--budget.left < 0) throw new SpecError(msg('toolgen.schemaTooLarge', { max: MAX_SCHEMA_NODES }));
  seen.add(schema);
  try {
    const out: JsonSchema = {};
    for (const [k, v] of Object.entries(schema)) {
      if (DROP_KEYS.has(k)) continue;
      if (k.startsWith('x-')) continue;
      if (SCHEMA_MAP_KEYS.includes(k) && isObj(v)) {
        out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toJsonSchema(pv, version, seen, budget)]));
      } else if (SCHEMA_ARRAY_KEYS.includes(k) && Array.isArray(v)) {
        out[k] = v.map((s) => toJsonSchema(s, version, seen, budget));
      } else if (SCHEMA_SINGLE_KEYS.includes(k) && isObj(v)) {
        out[k] = toJsonSchema(v, version, seen, budget);
      } else {
        out[k] = v;
      }
    }
    if (version !== '3.1') {
      // boolean exclusiveMinimum/Maximum (Draft 4) → numeric.
      for (const [flag, bound] of [
        ['exclusiveMinimum', 'minimum'],
        ['exclusiveMaximum', 'maximum'],
      ] as const) {
        if (typeof out[flag] === 'boolean') {
          if (out[flag] && typeof out[bound] === 'number') {
            out[flag] = out[bound];
            delete out[bound];
          } else {
            delete out[flag];
          }
        }
      }
      if (out.type === 'file') {
        out.type = 'string';
        out.format = 'binary';
      }
    }
    const nullable = schema.nullable === true || schema['x-nullable'] === true;
    if (nullable && typeof out.type === 'string') out.type = [out.type, 'null'];
    if (schema.example !== undefined && out.examples === undefined) out.examples = [schema.example];
    return out;
  } finally {
    seen.delete(schema);
  }
}

// ---------------------------------------------------------------- helpers

function pickContentType(content: Obj | undefined): string | undefined {
  if (!content) return undefined;
  const types = Object.keys(content);
  return (
    types.find((t) => t === 'application/json') ??
    types.find((t) => /^application\/[\w.+-]*\+?json/.test(t)) ??
    types.find((t) => t === '*/*') ??
    types[0]
  );
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

function extensions(op: Obj): Record<string, unknown> {
  return Object.fromEntries(Object.entries(op).filter(([k]) => k.startsWith('x-')));
}

function mergeParams(pathLevel: unknown, opLevel: unknown): Obj[] {
  const byKey = new Map<string, Obj>();
  for (const p of [...(Array.isArray(pathLevel) ? pathLevel : []), ...(Array.isArray(opLevel) ? opLevel : [])]) {
    if (isObj(p) && typeof p.name === 'string') byKey.set(`${p.in}:${p.name}`, p);
  }
  return [...byKey.values()];
}

const SWAGGER2_SCHEMA_FIELDS = [
  'type',
  'format',
  'items',
  'enum',
  'default',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'multipleOf',
  'x-nullable',
];

function swagger2ParamSchema(p: Obj): JsonSchema {
  const raw = Object.fromEntries(SWAGGER2_SCHEMA_FIELDS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
  return toJsonSchema(raw, '2.0');
}

// ---------------------------------------------------------------- normalize

export function normalizeSpec(spec: Obj): NormalizedSpec {
  const version = detectVersion(spec);
  const info = isObj(spec.info) ? spec.info : {};
  const operations: NormalizedOperation[] = [];
  const paths = isObj(spec.paths) ? spec.paths : {};

  for (const [path, item] of Object.entries(paths)) {
    if (!isObj(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      operations.push(
        version === '2.0' ? normalizeOp2(spec, path, method, item, op) : normalizeOp3(version, path, method, item, op),
      );
    }
  }
  operations.sort((a, b) => a.key.localeCompare(b.key));

  return {
    specVersion: version,
    title: str(info.title) ?? 'API',
    version: str(info.version) ?? '0',
    ...(str(info.description) ? { description: str(info.description) } : {}),
    servers: version === '2.0' ? servers2(spec) : servers3(spec),
    securitySchemes: securitySchemes(spec, version),
    operations,
  };
}

function baseOp(path: string, method: string, op: Obj): Omit<NormalizedOperation, 'parameters' | 'requestBody' | 'responses'> {
  return {
    key: `${method.toUpperCase()} ${path}`,
    method: method.toUpperCase(),
    path,
    ...(str(op.operationId) ? { operationId: str(op.operationId) } : {}),
    ...(str(op.summary) ? { summary: str(op.summary) } : {}),
    ...(str(op.description) ? { description: str(op.description) } : {}),
    tags: Array.isArray(op.tags) ? op.tags.filter((t): t is string => typeof t === 'string') : [],
    deprecated: op.deprecated === true,
    extensions: extensions(op),
  };
}

function normalizeOp3(version: SpecVersion, path: string, method: string, item: Obj, op: Obj): NormalizedOperation {
  const parameters: NormalizedParameter[] = mergeParams(item.parameters, op.parameters).map((p) => {
    const location = p.in as ParamLocation;
    const schema = isObj(p.schema) ? toJsonSchema(p.schema, version) : {};
    return {
      name: p.name as string,
      in: location,
      required: location === 'path' ? true : p.required === true,
      ...(str(p.description) ? { description: str(p.description) } : {}),
      schema,
      ...(schema.type === 'array' && location === 'query' ? { explode: p.explode !== false } : {}),
    };
  });

  let requestBody: NormalizedRequestBody | undefined;
  if (isObj(op.requestBody) && isObj(op.requestBody.content)) {
    const ct = pickContentType(op.requestBody.content);
    const media = ct ? op.requestBody.content[ct] : undefined;
    if (ct && isObj(media)) {
      requestBody = {
        required: op.requestBody.required === true,
        contentType: ct,
        ...(str(op.requestBody.description) ? { description: str(op.requestBody.description) } : {}),
        schema: toJsonSchema(media.schema, version),
      };
    }
  }

  const responses: NormalizedResponse[] = [];
  for (const [status, r] of Object.entries(isObj(op.responses) ? op.responses : {})) {
    if (!isObj(r)) continue;
    const content = isObj(r.content) ? r.content : undefined;
    const ct = pickContentType(content);
    const media = ct && content ? content[ct] : undefined;
    responses.push({
      status,
      ...(str(r.description) ? { description: str(r.description) } : {}),
      ...(ct ? { contentType: ct } : {}),
      ...(isObj(media) && isObj(media.schema) ? { schema: toJsonSchema(media.schema, version) } : {}),
    });
  }

  return { ...baseOp(path, method, op), parameters, ...(requestBody ? { requestBody } : {}), responses };
}

function normalizeOp2(spec: Obj, path: string, method: string, item: Obj, op: Obj): NormalizedOperation {
  const all = mergeParams(item.parameters, op.parameters);
  const consumes = (Array.isArray(op.consumes) ? op.consumes : Array.isArray(spec.consumes) ? spec.consumes : []) as string[];
  const produces = (Array.isArray(op.produces) ? op.produces : Array.isArray(spec.produces) ? spec.produces : []) as string[];

  const parameters: NormalizedParameter[] = all
    .filter((p) => p.in === 'path' || p.in === 'query' || p.in === 'header')
    .map((p) => {
      const schema = swagger2ParamSchema(p);
      return {
        name: p.name as string,
        in: p.in as ParamLocation,
        required: p.in === 'path' ? true : p.required === true,
        ...(str(p.description) ? { description: str(p.description) } : {}),
        schema,
        ...(schema.type === 'array' && p.in === 'query' ? { explode: p.collectionFormat === 'multi' } : {}),
      };
    });

  let requestBody: NormalizedRequestBody | undefined;
  const body = all.find((p) => p.in === 'body');
  const formData = all.filter((p) => p.in === 'formData');
  if (body) {
    requestBody = {
      required: body.required === true,
      contentType: consumes.find((c) => c.includes('json')) ?? consumes[0] ?? 'application/json',
      ...(str(body.description) ? { description: str(body.description) } : {}),
      schema: toJsonSchema(body.schema, '2.0'),
    };
  } else if (formData.length > 0) {
    const required = formData.filter((p) => p.required === true).map((p) => p.name as string);
    requestBody = {
      required: required.length > 0,
      contentType: consumes.find((c) => c.startsWith('multipart/')) ?? consumes[0] ?? 'application/x-www-form-urlencoded',
      schema: {
        type: 'object',
        properties: Object.fromEntries(
          formData.map((p) => [
            p.name as string,
            { ...swagger2ParamSchema(p), ...(str(p.description) ? { description: str(p.description) } : {}) },
          ]),
        ),
        ...(required.length ? { required } : {}),
      },
    };
  }

  const ct = produces.find((c) => c.includes('json')) ?? produces[0] ?? 'application/json';
  const responses: NormalizedResponse[] = [];
  for (const [status, r] of Object.entries(isObj(op.responses) ? op.responses : {})) {
    if (!isObj(r)) continue;
    responses.push({
      status,
      ...(str(r.description) ? { description: str(r.description) } : {}),
      ...(isObj(r.schema) ? { contentType: ct, schema: toJsonSchema(r.schema, '2.0') } : {}),
    });
  }

  return { ...baseOp(path, method, op), parameters, ...(requestBody ? { requestBody } : {}), responses };
}

function servers3(spec: Obj): string[] {
  if (!Array.isArray(spec.servers)) return [];
  return spec.servers.filter(isObj).map((s) => {
    let url = String(s.url ?? '');
    if (isObj(s.variables)) {
      for (const [name, v] of Object.entries(s.variables)) {
        if (isObj(v)) url = url.replaceAll(`{${name}}`, String(v.default ?? ''));
      }
    }
    return url;
  });
}

function servers2(spec: Obj): string[] {
  const basePath = typeof spec.basePath === 'string' ? spec.basePath : '';
  if (typeof spec.host !== 'string') return basePath ? [basePath] : [];
  const schemes = Array.isArray(spec.schemes) && spec.schemes.length ? (spec.schemes as string[]) : ['https'];
  return [`${schemes[0]}://${spec.host}${basePath === '/' ? '' : basePath}`];
}

function securitySchemes(spec: Obj, version: SpecVersion): Record<string, NormalizedSecurityScheme> {
  const raw =
    version === '2.0'
      ? spec.securityDefinitions
      : isObj(spec.components)
        ? (spec.components as Obj).securitySchemes
        : undefined;
  if (!isObj(raw)) return {};
  const out: Record<string, NormalizedSecurityScheme> = {};
  for (const [name, s] of Object.entries(raw)) {
    if (!isObj(s)) continue;
    out[name] = {
      type: s.type as NormalizedSecurityScheme['type'],
      ...(typeof s.in === 'string' ? { in: s.in } : {}),
      ...(typeof s.name === 'string' ? { name: s.name } : {}),
      ...(typeof s.scheme === 'string' ? { scheme: s.scheme } : {}),
    };
  }
  return out;
}

/** Shortcut: dereference + normalization. */
export async function parseSpec(spec: unknown): Promise<NormalizedSpec> {
  return normalizeSpec(await dereferenceSpec(spec));
}
