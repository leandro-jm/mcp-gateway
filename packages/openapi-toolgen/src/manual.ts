import type { BodyMapping, OperationRef, ParamMapping, ToolAnnotations } from '@mcp-gateway/core';
import { msg, translate, type ServerMessage } from '@mcp-gateway/i18n/server';
import { annotationsFor, snake } from './generate';
import { inferSchema } from './infer';
import type { JsonSchema } from './normalize';

export interface ManualParam {
  /** Name in the API. */
  name: string;
  in: 'path' | 'query' | 'header';
  /** Name in the tool input (default: the name itself, or snake_case for headers). */
  field?: string;
  required?: boolean;
  schema?: JsonSchema;
  description?: string;
}

export interface ManualToolSpec {
  method: string;
  path: string;
  params?: ManualParam[];
  body?: { schema: JsonSchema; mode?: 'flatten' | 'field'; field?: string; contentType?: string; required?: boolean };
  outputSchema?: JsonSchema | null;
  /** Sample response used to infer the output schema. */
  exampleResponse?: unknown;
  annotations?: ToolAnnotations;
}

export interface ManualToolBuild {
  inputSchema: JsonSchema;
  outputSchema: JsonSchema | null;
  operationRef: OperationRef;
  annotations: ToolAnnotations;
}

/** Invalid manual tool definition. `message` is English (logs); `msg` is rendered in the caller's locale. */
export class ManualToolError extends Error {
  constructor(readonly msg: ServerMessage) {
    super(translate(msg));
    this.name = 'ManualToolError';
  }
}

/**
 * Headers the agent must never control: credentials (applied by the gateway), hop-by-hop and
 * framing headers, and the ones upstreams trust for the caller's identity or address.
 */
export const RESERVED_HEADERS = /^(authorization|proxy-authorization|cookie|host|content-length|transfer-encoding|connection|te|upgrade|forwarded|x-forwarded-.*|x-real-ip|x-client-ip)$/i;

/** Builds the input schema and mapping of a manual tool (endpoint without OpenAPI, F7b.1). */
export function buildManualTool(spec: ManualToolSpec): ManualToolBuild {
  const method = spec.method.toUpperCase();
  if (!/^\//.test(spec.path)) throw new ManualToolError(msg('toolgen.manualPathSlash'));
  const templateParams = [...spec.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  const params = spec.params ?? [];
  for (const t of templateParams) {
    if (!params.some((p) => p.in === 'path' && p.name === t)) throw new ManualToolError(msg('toolgen.manualPathParamUnmapped', { param: `{${t}}` }));
  }
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const mapping: ParamMapping[] = [];
  for (const p of params) {
    if (p.in === 'header' && RESERVED_HEADERS.test(p.name)) throw new ManualToolError(msg('toolgen.manualHeaderNotAllowed', { header: p.name }));
    if (p.in === 'path' && !templateParams.includes(p.name)) throw new ManualToolError(msg('toolgen.manualPathParamNotInTemplate', { param: p.name }));
    const field = p.field ?? (p.in === 'header' ? snake(p.name) : p.name);
    if (!/^[A-Za-z_][\w]*$/.test(field)) throw new ManualToolError(msg('toolgen.manualInvalidField', { field }));
    if (properties[field]) throw new ManualToolError(msg('toolgen.manualDuplicateField', { field }));
    properties[field] = { ...(p.schema ?? { type: 'string' }), ...(p.description ? { description: p.description } : {}) };
    if (p.in === 'path' || p.required) required.push(field);
    mapping.push({ field, in: p.in, name: p.name });
  }

  let body: BodyMapping | undefined;
  if (spec.body) {
    const bs = spec.body.schema;
    const props = bs.properties as Record<string, JsonSchema> | undefined;
    const mode = spec.body.mode ?? (props && !Object.keys(props).some((k) => k in properties) ? 'flatten' : 'field');
    const contentType = spec.body.contentType ?? 'application/json';
    if (mode === 'flatten') {
      if (!props) throw new ManualToolError(msg('toolgen.manualFlattenNeedsProperties'));
      for (const [k, v] of Object.entries(props)) {
        if (properties[k]) throw new ManualToolError(msg('toolgen.manualBodyFieldCollides', { field: k }));
        properties[k] = v;
      }
      if (spec.body.required !== false) required.push(...((bs.required as string[] | undefined) ?? []));
      body = { mode, fields: Object.keys(props), contentType };
    } else {
      const field = spec.body.field ?? 'body';
      if (properties[field]) throw new ManualToolError(msg('toolgen.manualBodyFieldCollides', { field }));
      properties[field] = bs;
      if (spec.body.required) required.push(field);
      body = { mode, field, contentType };
    }
  }

  let outputSchema: JsonSchema | null = spec.outputSchema ?? (spec.exampleResponse !== undefined ? inferSchema(spec.exampleResponse) : null);
  let wrap: 'items' | 'value' | undefined;
  if (outputSchema && outputSchema.type !== 'object') {
    wrap = outputSchema.type === 'array' ? 'items' : 'value';
    outputSchema = { type: 'object', properties: { [wrap]: outputSchema } };
  }

  return {
    inputSchema: { type: 'object', properties, ...(required.length ? { required: [...new Set(required)] } : {}), additionalProperties: false },
    outputSchema,
    operationRef: {
      method,
      path: spec.path,
      mapping: { params: mapping, ...(body ? { body } : {}), response: { contentType: 'application/json', ...(wrap ? { wrap } : {}) } },
    },
    annotations: spec.annotations ?? annotationsFor(method),
  };
}
