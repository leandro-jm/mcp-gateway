import { msg, type ServerMessage } from '@mcp-gateway/i18n/server';
import type { JsonSchema } from '@mcp-gateway/openapi-toolgen';
import type { AuthCollector } from './auth';
import { templatePath } from './path-template';
import { capSchema, inferFromSamples, inferScalar, mergeScalars } from './schema';
import { importError, MAX_OPERATIONS, type CapturedRequest, type OpenApiDocument } from './types';

export interface BuildOptions {
  title: string;
  description?: string;
  auth: AuthCollector;
  warnings: ServerMessage[];
}

export interface BuildResult {
  openapi: OpenApiDocument;
  baseUrlCandidates: string[];
}

interface Group {
  method: string;
  path: string;
  requests: CapturedRequest[];
  pathSamples: Map<string, string[]>;
}

const MAX_LISTED_ORIGINS = 5;

/** Most frequent origin first. */
function rankOrigins(requests: CapturedRequest[]): string[] {
  const counts = new Map<string, number>();
  for (const r of requests) if (r.origin) counts.set(r.origin, (counts.get(r.origin) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([o]) => o);
}

function mediaType(contentType: string): string {
  return contentType.split(';')[0]!.trim().toLowerCase() || 'application/octet-stream';
}

function isJson(contentType: string | undefined): boolean {
  return !!contentType && /[/+]json\b/i.test(contentType);
}

function capped(schema: JsonSchema, operation: string, warnings: ServerMessage[]): JsonSchema {
  const r = capSchema(schema);
  if (r.truncated) warnings.push(msg('import.schemaTruncated', { operation }));
  return r.schema;
}

function buildParameters(group: Group): unknown[] {
  const params: unknown[] = [];
  const descriptions = Object.assign({}, ...group.requests.map((r) => r.pathParamDescriptions ?? {})) as Record<string, string>;
  for (const [name, samples] of group.pathSamples) {
    params.push({
      name,
      in: 'path',
      required: true,
      ...(descriptions[name] ? { description: descriptions[name] } : {}),
      schema: samples.length ? mergeScalars(samples.map(inferScalar)) : { type: 'string' },
    });
  }
  for (const where of ['query', 'header'] as const) {
    // headers are case-insensitive: the first spelling seen wins
    const seen = new Map<string, { name: string; values: string[] }>();
    for (const r of group.requests) {
      for (const p of where === 'query' ? r.query : r.headers) {
        const id = where === 'header' ? p.name.toLowerCase() : p.name;
        if (!seen.has(id)) seen.set(id, { name: p.name, values: [] });
        if (p.value && !/\{\{.*\}\}/.test(p.value)) seen.get(id)!.values.push(p.value);
      }
    }
    for (const { name, values } of seen.values()) {
      params.push({
        name,
        in: where,
        required: false,
        schema: where === 'header' ? { type: 'string' } : values.length ? mergeScalars(values.map(inferScalar)) : { type: 'string' },
      });
    }
  }
  return params;
}

function buildRequestBody(group: Group, key: string, warnings: ServerMessage[]): unknown {
  const withBody = group.requests.filter((r) => r.body);
  if (!withBody.length) return undefined;
  const kind = withBody[0]!.body!.kind;
  const contentType = mediaType(withBody[0]!.body!.contentType);
  const same = withBody.filter((r) => r.body!.kind === kind && mediaType(r.body!.contentType) === contentType).map((r) => r.body!);
  let schema: JsonSchema;
  if (kind === 'json') {
    schema = capped(inferFromSamples(same.map((b) => b.json)), key, warnings);
  } else if (kind === 'form') {
    const fields = new Map<string, { values: string[]; binary: boolean }>();
    for (const b of same) {
      for (const f of b.fields ?? []) {
        const entry = fields.get(f.name) ?? { values: [], binary: false };
        if (f.binary) entry.binary = true;
        else if (f.value && !/\{\{.*\}\}/.test(f.value)) entry.values.push(f.value);
        fields.set(f.name, entry);
      }
    }
    schema = {
      type: 'object',
      properties: Object.fromEntries(
        [...fields].map(([name, f]) => [name, f.binary ? { type: 'string', format: 'binary' } : f.values.length ? mergeScalars(f.values.map(inferScalar)) : { type: 'string' }]),
      ),
    };
  } else {
    schema = { type: 'string' };
  }
  return { required: withBody.length === group.requests.length, content: { [contentType]: { schema } } };
}

function buildResponses(group: Group, key: string, warnings: ServerMessage[]): Record<string, unknown> {
  const byStatus = new Map<number, { contentType?: string; samples: unknown[] }>();
  for (const r of group.requests) {
    for (const res of r.responses) {
      const entry = byStatus.get(res.status) ?? { samples: [] };
      if (res.contentType && !entry.contentType) entry.contentType = mediaType(res.contentType);
      if (res.json !== undefined && isJson(res.contentType)) entry.samples.push(res.json);
      byStatus.set(res.status, entry);
    }
  }
  if (!byStatus.size) return { '200': { description: 'Successful response' } };
  const out: Record<string, unknown> = {};
  for (const [status, entry] of [...byStatus].sort((a, b) => a[0] - b[0])) {
    out[String(status)] = {
      description: `HTTP ${status}`,
      ...(entry.samples.length ? { content: { [entry.contentType ?? 'application/json']: { schema: capped(inferFromSamples(entry.samples), key, warnings) } } } : {}),
    };
  }
  return out;
}

/**
 * Builds an OpenAPI 3.1 document from captured requests (ADR-014): keeps the most frequent origin,
 * strips credentials, templates paths and infers schemas without keeping any sample value.
 */
export function buildOpenApi(requests: CapturedRequest[], opts: BuildOptions): BuildResult {
  const { auth, warnings } = opts;
  const origins = rankOrigins(requests);
  const main = origins[0];
  const discarded = requests.filter((r) => r.origin && r.origin !== main);
  if (discarded.length) {
    const others = origins.slice(1);
    warnings.push(
      msg('import.originsDiscarded', {
        count: discarded.length,
        origins: others.slice(0, MAX_LISTED_ORIGINS).join(', ') + (others.length > MAX_LISTED_ORIGINS ? ', …' : ''),
      }),
    );
  }
  if (!main) warnings.push(msg('import.noBaseUrl'));

  const groups = new Map<string, Group>();
  for (const r of requests) {
    if (r.origin && r.origin !== main) continue;
    const method = r.method.toUpperCase();
    const templated = templatePath(r.path);
    const key = `${method} ${templated.path}`;
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= MAX_OPERATIONS) throw importError('import.tooManyOperations', { max: MAX_OPERATIONS });
      group = { method, path: templated.path, requests: [], pathSamples: new Map(templated.params.map((p) => [p.name, []])) };
      groups.set(key, group);
    }
    for (const p of templated.params) if (p.sample !== undefined) group.pathSamples.get(p.name)?.push(p.sample);
    group.requests.push({ ...r, headers: auth.headers(r.headers), query: auth.query(r.query) });
  }
  if (!groups.size) throw importError('import.noOperations');

  const paths: Record<string, Record<string, unknown>> = {};
  for (const [key, group] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const summary = group.requests.find((r) => r.summary)?.summary;
    const description = group.requests.find((r) => r.description)?.description;
    const tags = [...new Set(group.requests.map((r) => r.tag).filter((t): t is string => !!t))];
    const parameters = buildParameters(group);
    const requestBody = buildRequestBody(group, key, warnings);
    paths[group.path] ??= {};
    paths[group.path]![group.method.toLowerCase()] = {
      ...(summary ? { summary } : {}),
      ...(description ? { description } : {}),
      ...(tags.length ? { tags } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses: buildResponses(group, key, warnings),
    };
  }

  const security = auth.securityRequirement();
  const openapi: OpenApiDocument = {
    openapi: '3.1.0',
    info: { title: opts.title || 'Imported API', version: '1.0.0', ...(opts.description ? { description: opts.description } : {}) },
    ...(main ? { servers: [{ url: main }] } : {}),
    paths,
    ...(Object.keys(auth.schemes).length ? { components: { securitySchemes: auth.schemes } } : {}),
    ...(security.length ? { security } : {}),
  };
  return { openapi, baseUrlCandidates: main ? [main] : [] };
}
