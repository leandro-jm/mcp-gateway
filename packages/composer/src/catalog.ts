import type { ToolAnnotations } from '@mcp-gateway/core';
import { COMPOSER_LIMITS } from './limits';

type JsonSchema = Record<string, unknown>;

/** Catalog tool as the composer sees it (a subset of the registry snapshot tool). */
export interface ComposerTool {
  name: string;
  title?: string | null;
  description: string;
  state: 'enabled' | 'disabled' | 'deprecated' | 'removed';
  inputSchema: JsonSchema;
  outputSchema: JsonSchema | null;
  /** `operationRef.mapping.response.wrap`: how a non-object response was wrapped in the output schema. */
  responseWrap?: 'items' | 'value';
  annotations: ToolAnnotations;
}

/** Tool entry of the `<catalog>` block sent to the model. */
export interface PromptTool {
  name: string;
  title?: string;
  description: string;
  state: ComposerTool['state'];
  readOnly: boolean;
  destructive: boolean;
  input: JsonSchema;
  /** Shape of `$steps.<id>` (the raw upstream body); `null` = unknown. */
  output: JsonSchema | null;
}

const isObj = (v: unknown): v is JsonSchema => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Composite steps receive the raw upstream body, but tools store non-object responses wrapped
 * in `{ items }` or `{ value }` (structuredContent). Returns the schema of the raw body.
 */
export function unwrapOutputSchema(schema: JsonSchema | null, wrap: ComposerTool['responseWrap']): JsonSchema | null {
  if (!schema || !wrap) return schema;
  const inner = isObj(schema.properties) ? schema.properties[wrap] : undefined;
  return isObj(inner) ? inner : schema;
}

export interface CompactOptions {
  maxDepth: number;
  maxProps: number;
}

const KEPT = ['type', 'format', 'enum', 'const', 'nullable', 'minimum', 'maximum', 'default'] as const;
const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * Smaller JSON Schema for the prompt: keeps types, required fields, enums and short descriptions;
 * drops examples and deep nesting. Properties are sorted so the same tool always renders the same.
 */
export function compactSchema(schema: unknown, opts: CompactOptions = { maxDepth: 4, maxProps: 40 }, depth = 0): JsonSchema {
  if (!isObj(schema)) return {};
  const out: JsonSchema = {};
  for (const k of KEPT) {
    if (schema[k] === undefined) continue;
    out[k] = k === 'enum' && Array.isArray(schema.enum) ? schema.enum.slice(0, 20) : schema[k];
  }
  if (typeof schema.description === 'string') out.description = truncate(schema.description, 120);
  if (depth >= opts.maxDepth) return out;
  if (isObj(schema.properties)) {
    const names = Object.keys(schema.properties).sort().slice(0, opts.maxProps);
    out.properties = Object.fromEntries(names.map((n) => [n, compactSchema((schema.properties as JsonSchema)[n], opts, depth + 1)]));
    if (Array.isArray(schema.required)) out.required = (schema.required as string[]).filter((r) => names.includes(r));
  }
  if (schema.items !== undefined) out.items = compactSchema(schema.items, opts, depth + 1);
  for (const k of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(schema[k])) out[k] = (schema[k] as unknown[]).slice(0, 5).map((s) => compactSchema(s, opts, depth + 1));
  }
  return out;
}

export function toPromptTool(tool: ComposerTool): PromptTool {
  const output = unwrapOutputSchema(tool.outputSchema, tool.responseWrap);
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: truncate(tool.description.replace(/\s+/g, ' ').trim(), COMPOSER_LIMITS.maxDescriptionChars),
    state: tool.state,
    readOnly: tool.annotations.readOnlyHint === true,
    destructive: tool.annotations.destructiveHint === true,
    input: compactSchema(tool.inputSchema),
    output: output ? compactSchema(output) : null,
  };
}
