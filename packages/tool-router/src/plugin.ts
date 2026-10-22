import type { RoutableTool } from './builders';
import type { Confidence, GateOutcome } from './interpret';

export type RouterPoint = 'rerank' | 'shortlist' | 'gate';

/** Closed set of reasons: events carry codes, never free text (ADR-016). */
export type RouterReason =
  | 'ok'
  | 'low_confidence'
  | 'none_option'
  | 'refusal'
  | 'invalid'
  | 'too_many'
  | 'timeout'
  | 'error'
  | 'circuit_open'
  | 'budget'
  | 'no_intent'
  | 'human_confirmed'
  | 'disabled';

/**
 * What a router hook did: `applied`/`skipped` for rerank and shortlist (skipped = original result
 * kept), or the gate outcome.
 */
export interface RouterDecision {
  plugin: string;
  point: RouterPoint;
  decision: 'applied' | 'skipped' | GateOutcome;
  reason: RouterReason;
  ms?: number;
  provider?: string;
  model?: string;
  confidence?: Confidence;
  cached?: boolean;
  candidates?: number;
  kept?: number;
}

export interface RouterHookCtx {
  tenantId: string;
  signal?: AbortSignal;
}

/** `value` undefined = the plugin abstains and the next one (or the fallback) applies. */
export interface HookResult<T> {
  value?: T;
  decision: RouterDecision;
}

export interface RerankInput {
  query: string;
  /** Candidates in their current (search) order. */
  candidates: RoutableTool[];
}

export interface ShortlistInput {
  intent: string;
  /** Tools the subject can see (already filtered by policy). */
  tools: RoutableTool[];
}

export interface GateInput {
  tool: RoutableTool;
  /** Redacted argument object, or the argument names when the tenant sends no values. */
  args: unknown;
  intent?: string;
}

/**
 * Tool router plugin (ADR-025). Every hook is optional. Rerank returns names in the new order;
 * shortlist returns the names to keep; gate returns an outcome. The router service enforces that
 * rerank and shortlist outputs are subsets of their input.
 */
export interface ToolRouterPlugin {
  readonly name: string;
  rerank?(ctx: RouterHookCtx, input: RerankInput): Promise<HookResult<string[]>>;
  shortlist?(ctx: RouterHookCtx, input: ShortlistInput): Promise<HookResult<string[]>>;
  gate?(ctx: RouterHookCtx, input: GateInput): Promise<HookResult<GateOutcome>>;
}

/** Keeps only names present in the input, without duplicates: a plugin can never add a tool. */
export function subsetOf(input: readonly string[], output: readonly string[]): string[] {
  const allowed = new Set(input);
  return [...new Set(output.filter((n) => allowed.has(n)))];
}

const SEVERITY: Record<GateOutcome, number> = { allow: 0, confirm: 1, deny: 2 };

export function mostRestrictive(a: GateOutcome, b: GateOutcome): GateOutcome {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}
