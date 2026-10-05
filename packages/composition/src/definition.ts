import { isMessage } from '@mcp-gateway/i18n';
import { msg, raw, translate, type ServerMessage } from '@mcp-gateway/i18n/server';
import jsonata from 'jsonata';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const ident = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'id: snake_case');

export const stepSchema = z.object({
  id: ident,
  tool: z.string().min(1),
  /** String values starting with `$` are JSONata expressions; `{ "$literal": x }` forces a literal. */
  args: z.record(z.string(), z.unknown()).default({}),
  when: z.string().optional(),
  foreach: z
    .object({
      items: z.string().describe('JSONata expression that yields an array'),
      as: z.string().regex(/^[a-z][a-z0-9_]*$/).default('item'),
      max_items: z.number().int().positive().max(1000).default(100),
      concurrency: z.number().int().positive().max(20).default(4),
    })
    .optional(),
  /** Step value when `when` is false. */
  default: z.unknown().optional(),
  timeout_ms: z.number().int().positive().max(120_000).optional(),
});

export const compositeSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  title: z.string().optional(),
  description: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  steps: z.array(stepSchema).min(1),
  output: z.string().optional().describe('JSONata over { $input, $steps }; default: $steps'),
  failure_mode: z.enum(['abort', 'partial']).default('abort'),
  timeout_ms: z.number().int().positive().max(300_000).default(10_000),
});

export type CompositeStep = z.output<typeof stepSchema>;
export type CompositeDefinition = z.output<typeof compositeSchema>;

/** Path used for issues that concern the whole document (machine string, not translated). */
export const ROOT_PATH = '(root)';

/** Validation issue. `path` is a machine string; `message` is rendered by the caller in the user's locale (ADR-012). */
export interface Issue {
  path: string;
  message: ServerMessage;
}

/** Joins issues into one message (`path: message; path: message`), translatable as a whole. */
export function issuesMessage(issues: Issue[]): ServerMessage {
  const parts = issues.map((i) => msg('composition.issue', { path: i.path, message: i.message }));
  return parts.reduceRight<ServerMessage | undefined>((rest, part) => (rest ? msg('composition.issueList', { first: part, rest }) : part), undefined) ?? raw('');
}

/** Error with a translatable message: `message` is English (logs), `msg` is rendered in the caller's locale. */
export class CompositeError extends Error {
  constructor(
    readonly msg: ServerMessage,
    readonly stepId?: string,
    readonly code?: string,
    override readonly cause?: unknown,
  ) {
    super(translate(msg));
    this.name = 'CompositeError';
  }

  /** Wraps any thrown value, keeping its translatable message when it has one (e.g. `GatewayError`). */
  static from(err: unknown, stepId?: string): CompositeError {
    if (err instanceof CompositeError) return err;
    const m = (err as { msg?: unknown } | null)?.msg;
    const message = isMessage(m) ? (m as ServerMessage) : raw(err instanceof Error ? err.message : String(err));
    return new CompositeError(message, stepId, (err as { code?: string } | null)?.code, err);
  }
}

/** Invalid composite definition (YAML/JSON or schema). */
export class CompositeParseError extends Error {
  readonly msg: ServerMessage;

  constructor(readonly issues: Issue[]) {
    const m = msg('composition.invalidDefinition', { issues: issuesMessage(issues) });
    super(translate(m));
    this.name = 'CompositeParseError';
    this.msg = m;
  }
}

/** Reads the definition from YAML/JSON (text) or from an object. */
export function parseComposite(source: string | unknown): CompositeDefinition {
  let data: unknown = source;
  if (typeof source === 'string') {
    try {
      data = source.trimStart().startsWith('{') ? JSON.parse(source) : parseYaml(source, { maxAliasCount: 50 });
    } catch (err) {
      throw new CompositeParseError([{ path: ROOT_PATH, message: msg('composition.invalidYaml', { error: (err as Error).message }) }]);
    }
  }
  const r = compositeSchema.safeParse(data);
  if (!r.success) throw new CompositeParseError(r.error.issues.map((i) => ({ path: i.path.join('.') || ROOT_PATH, message: raw(i.message) })));
  return r.data;
}

// ---------------------------------------------------------------- expressions

export const isExpr = (v: unknown): v is string => typeof v === 'string' && v.startsWith('$');
const isLiteralWrapper = (v: unknown): v is { $literal: unknown } =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && '$literal' in v;

/** All expressions of an argument value (recursive). */
export function expressionsIn(value: unknown): string[] {
  if (isExpr(value)) return [value];
  if (isLiteralWrapper(value)) return [];
  if (Array.isArray(value)) return value.flatMap(expressionsIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(expressionsIn);
  return [];
}

const STEP_REF = /\$steps(?:\.([A-Za-z_][\w]*)|\[\s*["']([^"']+)["']\s*\])/g;

/** Step ids referenced by an expression (`$steps.colab.id`, `$steps["colab"]`). */
export function stepRefs(expr: string): string[] {
  return [...expr.matchAll(STEP_REF)].map((m) => (m[1] ?? m[2])!);
}

/**
 * Native JSONata guardrails (ADR-013), checked at every evaluation step. A `setTimeout` cannot
 * interrupt JSONata: it evaluates on microtasks and never yields to the timer queue.
 */
export const EXPR_LIMITS = { timeout: 1000, stack: 500, sequence: 100_000 } as const;

/** JSONata error codes raised by the guardrails (stack, timeout, sequence length). */
export const EXPR_LIMIT_CODES = new Set(['D1011', 'D1012', 'D2015']);

export function compileExpr(expr: string): jsonata.Expression {
  return jsonata(expr, EXPR_LIMITS);
}

export function stepExpressions(step: CompositeStep): string[] {
  return [...expressionsIn(step.args), ...(step.when ? [step.when] : []), ...(step.foreach ? [step.foreach.items] : [])];
}

export function stepDependencies(step: CompositeStep): string[] {
  return [...new Set(stepExpressions(step).flatMap(stepRefs))];
}

/** Sorts the steps into levels (each level may run in parallel). Throws a `CompositeError` (code `CYCLE`) on a cycle. */
export function topoLevels(steps: CompositeStep[]): string[][] {
  const deps = new Map(steps.map((s) => [s.id, new Set(stepDependencies(s).filter((d) => d !== s.id))]));
  const done = new Set<string>();
  const levels: string[][] = [];
  while (done.size < steps.length) {
    const level = steps.filter((s) => !done.has(s.id) && [...deps.get(s.id)!].every((d) => done.has(d))).map((s) => s.id);
    if (!level.length) {
      const pending = steps.filter((s) => !done.has(s.id)).map((s) => s.id);
      throw new CompositeError(msg('composition.cycle', { steps: pending.join(', ') }), undefined, 'CYCLE');
    }
    level.forEach((id) => done.add(id));
    levels.push(level);
  }
  return levels;
}
