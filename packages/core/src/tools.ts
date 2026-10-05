/** Tool domain rules (pure). */

export type ToolState = 'disabled' | 'enabled' | 'deprecated' | 'removed';
export type ToolKind = 'openapi' | 'manual' | 'composite';
export type ToolAction = 'enable' | 'disable' | 'deprecate';

export interface ToolOverrides {
  name?: string;
  title?: string;
  description?: string;
  /** JSON Merge Patch (RFC 7386) applied over the generated input schema. */
  inputSchema?: Record<string, unknown>;
}

export interface ToolBase {
  name: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  overrides: ToolOverrides | Record<string, unknown>;
}

export const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const ACTION_TARGET: Record<ToolAction, ToolState> = {
  enable: 'enabled',
  disable: 'disabled',
  deprecate: 'deprecated',
};

/** Transitions allowed via the Admin API. `removed` is terminal (only the crawler changes it). */
const ALLOWED: Record<ToolState, ToolState[]> = {
  disabled: ['enabled', 'deprecated'],
  enabled: ['disabled', 'deprecated'],
  deprecated: ['enabled', 'disabled'],
  removed: [],
};

export function targetState(action: ToolAction): ToolState {
  return ACTION_TARGET[action];
}

export function canTransition(from: ToolState, to: ToolState): boolean {
  return ALLOWED[from].includes(to);
}

/** JSON Merge Patch (RFC 7386). */
export function jsonMergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const base: Record<string, unknown> =
    target && typeof target === 'object' && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete base[k];
    else base[k] = jsonMergePatch(base[k], v);
  }
  return base;
}

export interface EffectiveTool {
  name: string;
  baseName: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Applies the owner's overrides over the generated fields. */
export function applyOverrides(tool: ToolBase): EffectiveTool {
  const o = tool.overrides as ToolOverrides;
  return {
    name: o.name ?? tool.name,
    baseName: tool.name,
    title: o.title ?? tool.title,
    description: o.description ?? tool.description,
    inputSchema: o.inputSchema
      ? (jsonMergePatch(tool.inputSchema, o.inputSchema) as Record<string, unknown>)
      : tool.inputSchema,
  };
}

// ---------------------------------------------------------------- upstream operation

/** How a field of the tool input becomes part of the HTTP request. */
export interface ParamMapping {
  /** Field name in the tool's input schema. */
  field: string;
  in: 'path' | 'query' | 'header';
  /** Parameter name in the API. */
  name: string;
  /** Arrays in query: `true` = a=1&a=2; `false` = a=1,2. */
  explode?: boolean;
}

export interface BodyMapping {
  /** `flatten`: body properties are at the top of the input; `field`: the whole body is in `field`. */
  mode: 'flatten' | 'field';
  field?: string;
  /** Input fields that make up the body (flatten mode). */
  fields?: string[];
  contentType: string;
}

export interface ResponseMapping {
  /** A non-object response is wrapped in `{ items }` (array) or `{ value }` to become `structuredContent`. */
  wrap?: 'items' | 'value';
  contentType?: string;
}

export interface OperationMapping {
  params: ParamMapping[];
  body?: BodyMapping;
  response?: ResponseMapping;
}

export interface OperationRef {
  method: string;
  path: string;
  operationId?: string;
  mapping?: OperationMapping;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
