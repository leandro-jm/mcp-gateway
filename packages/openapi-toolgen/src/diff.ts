import type { JsonSchema } from './normalize';

export type ChangeKind =
  | 'required_added'
  | 'field_removed'
  | 'type_changed'
  | 'enum_narrowed'
  | 'field_added'
  | 'required_removed'
  | 'enum_widened'
  | 'description_changed'
  | 'name_changed'
  | 'annotations_changed'
  | 'operation_changed';

export interface SchemaChange {
  kind: ChangeKind;
  /** `input.foo.bar`, `output.items[].id`, `description`… */
  path: string;
  breaking: boolean;
  from?: unknown;
  to?: unknown;
}

export interface ToolDiff {
  breaking: boolean;
  changes: SchemaChange[];
}

export interface DiffableTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema | null;
  annotations: object;
  operationRef?: { method: string; path: string } | null;
}

const isObj = (v: unknown): v is JsonSchema => typeof v === 'object' && v !== null && !Array.isArray(v);

function typeOf(s: JsonSchema): string | undefined {
  if (Array.isArray(s.type)) return [...(s.type as string[])].sort().join('|');
  if (typeof s.type === 'string') return s.type;
  if (isObj(s.properties)) return 'object';
  if (isObj(s.items)) return 'array';
  return undefined;
}

/**
 * Compares schemas. `side` defines what is breaking:
 * - input (sent by the agent): new required field, removed field, changed type, narrowed enum.
 * - output (consumed by the agent/composites): removed field, changed type.
 */
function compareSchemas(prev: JsonSchema, next: JsonSchema, path: string, side: 'input' | 'output', out: SchemaChange[]) {
  const tPrev = typeOf(prev);
  const tNext = typeOf(next);
  if (tPrev && tNext && tPrev !== tNext) {
    out.push({ kind: 'type_changed', path, breaking: true, from: tPrev, to: tNext });
    return;
  }
  if (Array.isArray(prev.enum) && Array.isArray(next.enum)) {
    const removed = prev.enum.filter((v) => !(next.enum as unknown[]).includes(v));
    const added = next.enum.filter((v) => !(prev.enum as unknown[]).includes(v));
    if (removed.length) out.push({ kind: 'enum_narrowed', path, breaking: side === 'input', from: removed });
    if (added.length) out.push({ kind: 'enum_widened', path, breaking: side === 'output', to: added });
  }
  const pp = isObj(prev.properties) ? prev.properties : {};
  const np = isObj(next.properties) ? next.properties : {};
  const prevReq = new Set(Array.isArray(prev.required) ? (prev.required as string[]) : []);
  const nextReq = new Set(Array.isArray(next.required) ? (next.required as string[]) : []);
  for (const k of Object.keys(pp)) {
    const p = `${path}.${k}`;
    if (!(k in np)) out.push({ kind: 'field_removed', path: p, breaking: true });
    else if (isObj(pp[k]) && isObj(np[k])) compareSchemas(pp[k] as JsonSchema, np[k] as JsonSchema, p, side, out);
  }
  for (const k of Object.keys(np)) {
    if (!(k in pp)) out.push({ kind: 'field_added', path: `${path}.${k}`, breaking: false });
  }
  for (const k of nextReq) {
    if (!prevReq.has(k)) out.push({ kind: 'required_added', path: `${path}.${k}`, breaking: side === 'input' });
  }
  for (const k of prevReq) {
    if (!nextReq.has(k) && k in np) out.push({ kind: 'required_removed', path: `${path}.${k}`, breaking: side === 'output' });
  }
  if (isObj(prev.items) && isObj(next.items)) compareSchemas(prev.items, next.items, `${path}[]`, side, out);
}

export function diffTools(prev: DiffableTool, next: DiffableTool): ToolDiff {
  const changes: SchemaChange[] = [];
  compareSchemas(prev.inputSchema, next.inputSchema, 'input', 'input', changes);
  if (prev.outputSchema && next.outputSchema) {
    compareSchemas(prev.outputSchema, next.outputSchema, 'output', 'output', changes);
  } else if (prev.outputSchema && !next.outputSchema) {
    changes.push({ kind: 'field_removed', path: 'output', breaking: true });
  } else if (!prev.outputSchema && next.outputSchema) {
    changes.push({ kind: 'field_added', path: 'output', breaking: false });
  }
  if (prev.name !== next.name) changes.push({ kind: 'name_changed', path: 'name', breaking: false, from: prev.name, to: next.name });
  if (prev.description !== next.description) changes.push({ kind: 'description_changed', path: 'description', breaking: false });
  if (JSON.stringify(prev.annotations) !== JSON.stringify(next.annotations)) {
    changes.push({ kind: 'annotations_changed', path: 'annotations', breaking: false, from: prev.annotations, to: next.annotations });
  }
  if (prev.operationRef && next.operationRef && (prev.operationRef.method !== next.operationRef.method || prev.operationRef.path !== next.operationRef.path)) {
    changes.push({ kind: 'operation_changed', path: 'operation', breaking: true });
  }
  return { breaking: changes.some((c) => c.breaking), changes };
}

/** Short summary for webhooks and the UI. */
export function summarizeDiff(diff: ToolDiff): string {
  if (!diff.changes.length) return 'no changes';
  const counts = new Map<ChangeKind, number>();
  for (const c of diff.changes) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${k}×${n}`).join(', ');
}
