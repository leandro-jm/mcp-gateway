import { DEFAULT_LOCALE, type Locale } from '@mcp-gateway/i18n';
import { msg, translate, type ServerMessage } from '@mcp-gateway/i18n/server';
import { compileExpr, CompositeError, EXPR_LIMIT_CODES, isExpr, stepDependencies, type CompositeDefinition, type CompositeStep } from './definition';

export interface StepCall {
  stepId: string;
  tool: string;
  args: Record<string, unknown>;
  /** Item index in `foreach`. */
  index?: number;
  signal: AbortSignal;
}

export interface ExecuteLimits {
  /** Total calls per execution (counting `foreach`). */
  maxCalls: number;
  /** Summed bytes of intermediate results. */
  maxIntermediateBytes: number;
}

export interface ExecuteOptions {
  callStep(call: StepCall): Promise<unknown>;
  limits?: Partial<ExecuteLimits>;
  /** Cache by (tool, args) within the same execution. */
  cache?: boolean;
  /** Locale of the `_errors` messages embedded in a `partial` output (default `en`). */
  locale?: Locale;
}

export type StepStatus = 'ok' | 'skipped' | 'failed';

/** Step failure: `message` is English (logs); `msg` is rendered in the caller's locale. */
export interface StepError {
  message: string;
  code?: string;
  msg?: ServerMessage;
}

export interface StepReport {
  status: StepStatus;
  value: unknown;
  error?: StepError;
  calls: number;
  startedAt: number;
  durationMs: number;
}

export interface ExecuteResult {
  output: unknown;
  steps: Record<string, StepReport>;
  errors: Record<string, StepError>;
  calls: number;
  durationMs: number;
}

const GLOBAL_TIMEOUT = msg('composition.globalTimeout');

const DEFAULT_LIMITS: ExecuteLimits = { maxCalls: 100, maxIntermediateBytes: 5 * 1024 * 1024 };

function withTimeout<T>(p: Promise<T>, ms: number, message: ServerMessage, code = 'TIMEOUT'): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new CompositeError(message, undefined, code)), ms);
    }),
  ]);
}

async function evalExpr(expr: string, bindings: Record<string, unknown>): Promise<unknown> {
  let v: unknown;
  try {
    v = await compileExpr(expr).evaluate({}, bindings);
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown } | null;
    if (typeof e?.code === 'string' && EXPR_LIMIT_CODES.has(e.code)) {
      throw new CompositeError(msg('composition.exprLimit', { reason: String(e.message ?? e.code) }), undefined, 'LIMIT_EXPR', err);
    }
    throw err;
  }
  // JSONata returns "sequence" arrays with metadata; normalize to plain JSON.
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

async function resolveArgs(value: unknown, bindings: Record<string, unknown>): Promise<unknown> {
  if (isExpr(value)) return evalExpr(value, bindings);
  if (Array.isArray(value)) return Promise.all(value.map((v) => resolveArgs(v, bindings)));
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 1 && '$literal' in value) return (value as { $literal: unknown }).$literal;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = await resolveArgs(v, bindings);
      if (r !== undefined) out[k] = r; // argument omitted when the expression yields no value
    }
    return out;
  }
  return value;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Runs a composition (PLAN F7b.3). Steps without dependencies between them run in parallel;
 * each step waits only for its own dependencies. I/O belongs to the caller (`callStep`): the package is pure.
 */
export async function executeComposite(def: CompositeDefinition, input: Record<string, unknown>, opts: ExecuteOptions): Promise<ExecuteResult> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const started = Date.now();
  const controller = new AbortController();
  const steps: Record<string, StepReport> = {};
  const values: Record<string, unknown> = {};
  const cache = new Map<string, Promise<unknown>>();
  let calls = 0;
  let bytes = 0;
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const promises = new Map<string, Promise<void>>();

  const call = async (step: CompositeStep, args: Record<string, unknown>, index?: number): Promise<unknown> => {
    calls += 1;
    if (calls > limits.maxCalls) throw new CompositeError(msg('composition.callLimit', { max: limits.maxCalls }), step.id, 'LIMIT_CALLS');
    const key = `${step.tool}:${JSON.stringify(args)}`;
    if (opts.cache !== false && cache.has(key)) return cache.get(key);
    const p = (async () => {
      const req = opts.callStep({ stepId: step.id, tool: step.tool, args, ...(index !== undefined ? { index } : {}), signal: controller.signal });
      return step.timeout_ms ? withTimeout(req, step.timeout_ms, msg('composition.stepTimeout', { step: step.id, ms: step.timeout_ms })) : req;
    })();
    if (opts.cache !== false) cache.set(key, p);
    return p;
  };

  const run = (step: CompositeStep): Promise<void> => {
    const existing = promises.get(step.id);
    if (existing) return existing;
    const p = (async () => {
      const deps = stepDependencies(step).filter((d) => d !== step.id && byId.has(d));
      await Promise.all(deps.map((d) => run(byId.get(d)!)));
      const t0 = Date.now();
      const report: StepReport = { status: 'ok', value: null, calls: 0, startedAt: t0 - started, durationMs: 0 };
      steps[step.id] = report;
      const failedDep = deps.find((d) => steps[d]?.status === 'failed');
      try {
        if (failedDep) throw new CompositeError(msg('composition.dependencyFailed', { step: failedDep }), step.id, 'DEPENDENCY_FAILED');
        const bindings = { input, steps: values };
        if (step.when !== undefined && !(await evalExpr(step.when, bindings))) {
          report.status = 'skipped';
          report.value = step.default ?? null;
          // Without a default it stays undefined: JSONata omits the field from the output.
          values[step.id] = step.default;
          return;
        }
        const before = calls;
        if (step.foreach) {
          const raw = await evalExpr(step.foreach.items, bindings);
          const items = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
          if (items.length > step.foreach.max_items) {
            throw new CompositeError(msg('composition.foreachLimit', { step: step.id, count: items.length, max: step.foreach.max_items }), step.id, 'LIMIT_FOREACH');
          }
          report.value = await mapLimit(items, step.foreach.concurrency, async (item, index) => {
            const args = (await resolveArgs(step.args, { ...bindings, [step.foreach!.as]: item, index })) as Record<string, unknown>;
            return call(step, args, index);
          });
        } else {
          const args = (await resolveArgs(step.args, bindings)) as Record<string, unknown>;
          report.value = await call(step, args);
        }
        report.calls = calls - before;
        bytes += Buffer.byteLength(JSON.stringify(report.value) ?? '');
        if (bytes > limits.maxIntermediateBytes) {
          throw new CompositeError(msg('composition.intermediateBytes', { max: limits.maxIntermediateBytes }), step.id, 'LIMIT_BYTES');
        }
        values[step.id] = report.value;
      } catch (err) {
        const e = CompositeError.from(err, step.id);
        report.status = 'failed';
        report.value = null;
        report.error = { message: e.message, ...(e.code ? { code: e.code } : {}), msg: e.msg };
        values[step.id] = null;
        if (def.failure_mode === 'abort') throw new CompositeError(msg('composition.stepFailed', { step: step.id, error: e.msg }), step.id, e.code, e.cause ?? e);
      } finally {
        report.durationMs = Date.now() - t0;
      }
    })();
    promises.set(step.id, p);
    return p;
  };

  const all = Promise.all(def.steps.map(run));
  try {
    await withTimeout(all, def.timeout_ms, msg('composition.timeout', { ms: def.timeout_ms }));
  } catch (err) {
    controller.abort();
    const timedOut = err instanceof CompositeError && err.code === 'TIMEOUT' && !err.stepId;
    if (!timedOut || def.failure_mode === 'abort') throw err;
    for (const s of def.steps) {
      if (!steps[s.id] || (steps[s.id]!.status === 'ok' && !(s.id in values))) {
        steps[s.id] = { status: 'failed', value: null, error: { message: translate(GLOBAL_TIMEOUT), code: 'TIMEOUT', msg: GLOBAL_TIMEOUT }, calls: 0, startedAt: 0, durationMs: 0 };
        values[s.id] = null;
      }
    }
  }

  const errors = Object.fromEntries(Object.entries(steps).filter(([, r]) => r.error).map(([id, r]) => [id, r.error!]));
  let output = def.output ? await evalExpr(def.output, { input, steps: values }) : { ...values };
  if (output === undefined) output = null;
  if (def.failure_mode === 'partial' && Object.keys(errors).length && output && typeof output === 'object' && !Array.isArray(output)) {
    // embedded in the tool result read by the agent: rendered in the caller's locale, without the raw Message
    const locale = opts.locale ?? DEFAULT_LOCALE;
    const rendered = Object.fromEntries(
      Object.entries(errors).map(([id, e]) => [id, { message: e.msg ? translate(e.msg, locale) : e.message, ...(e.code ? { code: e.code } : {}) }]),
    );
    output = { ...(output as Record<string, unknown>), _errors: rendered };
  }
  return { output, steps, errors, calls, durationMs: Date.now() - started };
}
