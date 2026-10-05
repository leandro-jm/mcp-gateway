import type { ToolAnnotations } from '@mcp-gateway/core';
import { msg, raw, type ServerMessageKey } from '@mcp-gateway/i18n/server';
import {
  compileExpr,
  CompositeError,
  expressionsIn,
  isExpr,
  stepDependencies,
  stepRefs,
  topoLevels,
  type CompositeDefinition,
  type Issue,
} from './definition';

export interface CatalogTool {
  id: string;
  name: string;
  kind: 'openapi' | 'manual' | 'composite';
  state: 'enabled' | 'disabled' | 'deprecated' | 'removed';
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
}

export interface ValidationLimits {
  maxSteps: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: Issue[];
  warnings: Issue[];
  /** Ids of the tools used by the steps (for `depends_on_tools` and cascading drift). */
  dependsOn: string[];
  levels: string[][];
  /** Annotations inherited from the steps (F7b.4). */
  annotations: ToolAnnotations;
}

/** Issues that make the topological sort meaningless. */
const BLOCKS_TOPOLOGY = new Set<ServerMessageKey>(['composition.unknownStep', 'composition.unknownTool', 'composition.duplicateStepId']);

const jsonType = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v;

function literalMatches(schema: Record<string, unknown>, value: unknown): boolean {
  if (schema.type === undefined) return true;
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  const t = jsonType(value);
  if (typeof value === 'object' && value !== null && '$literal' in value) return literalMatches(schema, (value as { $literal: unknown }).$literal);
  return types.includes(t) || (t === 'integer' && types.includes('number'));
}

/**
 * Static validation (F7b.2): cycles, references to unknown steps, unknown, removed or composite
 * tools (no recursion in v1), JSONata syntax and args vs input schema.
 */
export function validateComposite(
  def: CompositeDefinition,
  catalog: Map<string, CatalogTool>,
  limits: ValidationLimits = { maxSteps: 20 },
): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const ids = new Set<string>();
  const dependsOn = new Set<string>();
  const used: CatalogTool[] = [];

  if (def.steps.length > limits.maxSteps) errors.push({ path: 'steps', message: msg('composition.maxSteps', { max: limits.maxSteps }) });

  def.steps.forEach((step, i) => {
    const p = `steps[${i}](${step.id})`;
    if (ids.has(step.id)) errors.push({ path: p, message: msg('composition.duplicateStepId', { step: step.id }) });
    ids.add(step.id);
  });

  def.steps.forEach((step, i) => {
    const p = `steps[${i}](${step.id})`;
    for (const expr of [...expressionsIn(step.args), ...(step.when ? [step.when] : []), ...(step.foreach ? [step.foreach.items] : [])]) {
      try {
        compileExpr(expr);
      } catch (err) {
        errors.push({ path: p, message: msg('composition.invalidExpression', { expr, error: (err as Error).message }) });
      }
    }
    for (const ref of stepDependencies(step)) {
      if (ref === step.id) errors.push({ path: p, message: msg('composition.selfReference') });
      else if (!ids.has(ref)) errors.push({ path: p, message: msg('composition.unknownStep', { step: ref }) });
    }

    const tool = catalog.get(step.tool);
    if (!tool) {
      errors.push({ path: `${p}.tool`, message: msg('composition.unknownTool', { tool: step.tool }) });
      return;
    }
    if (tool.state === 'removed') errors.push({ path: `${p}.tool`, message: msg('composition.removedTool', { tool: step.tool }) });
    if (tool.kind === 'composite') errors.push({ path: `${p}.tool`, message: msg('composition.nestedComposite') });
    if (tool.state === 'disabled' || tool.state === 'deprecated') warnings.push({ path: `${p}.tool`, message: msg('composition.toolNotEnabled', { tool: step.tool, state: tool.state }) });
    dependsOn.add(tool.id);
    used.push(tool);

    // args vs the referenced tool's input schema (static check)
    const props = (tool.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = (tool.inputSchema.required ?? []) as string[];
    for (const r of required) {
      if (!(r in step.args)) errors.push({ path: `${p}.args`, message: msg('composition.missingArg', { tool: step.tool, arg: r }) });
    }
    for (const [k, v] of Object.entries(step.args)) {
      if (!(k in props)) {
        if (tool.inputSchema.additionalProperties === false) errors.push({ path: `${p}.args.${k}`, message: msg('composition.unexpectedArg', { tool: step.tool }) });
        continue;
      }
      if (!isExpr(v) && !literalMatches(props[k]!, v)) {
        errors.push({ path: `${p}.args.${k}`, message: msg('composition.literalTypeMismatch', { type: JSON.stringify(props[k]!.type) }) });
      }
    }
  });

  if (def.output) {
    try {
      compileExpr(def.output);
    } catch (err) {
      errors.push({ path: 'output', message: msg('composition.invalidOutputExpression', { error: (err as Error).message }) });
    }
    for (const ref of stepRefs(def.output)) if (!ids.has(ref)) errors.push({ path: 'output', message: msg('composition.unknownStep', { step: ref }) });
  }

  let levels: string[][] = [];
  // a DAG only makes sense when every step reference resolves and ids are unique
  if (!errors.some((e) => BLOCKS_TOPOLOGY.has(e.message.key))) {
    try {
      levels = topoLevels(def.steps);
    } catch (err) {
      errors.push({ path: 'steps', message: err instanceof CompositeError ? err.msg : raw((err as Error).message) });
    }
  }

  const annotations: ToolAnnotations = {
    readOnlyHint: used.length > 0 && used.every((t) => t.annotations.readOnlyHint === true),
    ...(used.some((t) => t.annotations.destructiveHint) ? { destructiveHint: true } : {}),
    ...(used.length > 0 && used.every((t) => t.annotations.readOnlyHint || t.annotations.idempotentHint) ? { idempotentHint: true } : {}),
  };

  return { valid: errors.length === 0, errors, warnings, dependsOn: [...dependsOn], levels, annotations };
}
