import { effectiveNetworkPolicy, isGatewayError, RateLimited, readToolRouterSettings, type ToolRouterSettings } from '@mcp-gateway/core';
import type { DecisionSettingsRepo } from '@mcp-gateway/db';
import {
  decisionCacheKey,
  mergeRanking,
  mostRestrictive,
  subsetOf,
  type DecisionProvider,
  type GateOutcome,
  type HookResult,
  type RoutableTool,
  type RouterDecision,
  type RouterHookCtx,
  type RouterPoint,
  type RouterReason,
  type ToolRouterPlugin,
} from '@mcp-gateway/tool-router';
import type { Logger } from '../logger';
import type { CallContext } from '../proxy/executor';
import { CircuitOpen, type CircuitBreaker, type CircuitConfig, type RateLimiter } from '../proxy/guards';
import type { PiiService } from '../proxy/pii';
import type { RegistrySnapshot, SnapshotTool } from '../registry/snapshot';
import type { ToolSearch } from '../search/tool-search';
import type { DecisionCache } from './cache';
import type { DecisionProviderFactory } from './factory';
import { RouterPluginRegistry } from './registry';

/** Plugin name of decisions the service takes itself (fallbacks, cache hits, human confirmation). */
export const ROUTER_PLUGIN = 'router';
const CLIENT_TTL_MS = 60_000;
const CIRCUIT: CircuitConfig = { failureThreshold: 5, windowMs: 30_000, cooldownMs: 30_000 };

export function toRoutable(t: SnapshotTool): RoutableTool {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    readOnly: Boolean(t.annotations.readOnlyHint),
    destructive: Boolean(t.annotations.destructiveHint),
    tags: t.tags,
  };
}

export interface ToolRouterDeps {
  settingsRepo: Pick<DecisionSettingsRepo, 'getDecrypted'>;
  providers: DecisionProviderFactory;
  cache: DecisionCache;
  budget: Pick<RateLimiter, 'check'>;
  circuit: CircuitBreaker;
  pii: Pick<PiiService, 'redactForLog' | 'redactText'>;
  logger: Logger;
  allowPrivateNetworks: boolean;
  /** Pre-filter of the `tool` shortlist granularity; without it every visible tool is a candidate. */
  search?: Pick<ToolSearch, 'search'>;
  plugins?: RouterPluginRegistry;
}

/** Rerank/shortlist result: `names` is always usable (the original list on any fallback). */
export interface RouterResult {
  names: string[];
  applied: boolean;
  decision: RouterDecision;
}

export interface GateResult {
  outcome: GateOutcome;
  /** What the executor does: `confirm` resolves to allow or deny by `onConfirmWithoutUi`. */
  effective: 'allow' | 'deny';
  message?: 'router.gateDenied' | 'router.confirmationRequired';
  decision: RouterDecision;
}

const isAbort = (err: unknown) => err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

/** Why a consultation failed, as a closed reason code (the error message never leaves the gateway). */
export function failureReason(err: unknown): RouterReason {
  if (err instanceof RateLimited) return 'budget';
  if (err instanceof CircuitOpen) return 'circuit_open';
  if (isAbort(err) || (isGatewayError(err) && err.msg.key === 'router.timeout')) return 'timeout';
  if (isGatewayError(err) && err.msg.key === 'router.invalidResponse') return 'invalid';
  return 'error';
}

const elapsed = (t0: number) => Math.round(performance.now() - t0);

/**
 * Decision-model tool router (ADR-025). It only narrows what the policy already allowed, and any
 * failure falls back to the behavior without the router (the gate follows `onError`). Callers
 * check `enabledFor`/`gateApplies` first: with the router off nothing here runs.
 */
export class ToolRouter {
  private readonly settingsBySnapshot = new WeakMap<RegistrySnapshot, ToolRouterSettings>();
  private readonly clients = new Map<string, { provider: DecisionProvider | null; expires: number }>();
  private readonly plugins: RouterPluginRegistry;

  constructor(private readonly deps: ToolRouterDeps) {
    this.plugins = deps.plugins ?? RouterPluginRegistry.withDefaults();
  }

  settings(ctx: Pick<CallContext, 'snapshot'>): ToolRouterSettings {
    let s = this.settingsBySnapshot.get(ctx.snapshot);
    if (!s) {
      s = readToolRouterSettings(ctx.snapshot.tenant.settings);
      this.settingsBySnapshot.set(ctx.snapshot, s);
    }
    return s;
  }

  /** Synchronous and snapshot-only: the cheap check every hook point does first. */
  enabledFor(ctx: Pick<CallContext, 'snapshot'>, point: RouterPoint): boolean {
    const s = this.settings(ctx);
    return s.enabled && s[point].enabled;
  }

  gateApplies(ctx: Pick<CallContext, 'snapshot'>, tool: SnapshotTool): boolean {
    if (!this.enabledFor(ctx, 'gate')) return false;
    const scope = this.settings(ctx).gate.scope;
    if (scope === 'all') return true;
    return scope === 'destructive' ? Boolean(tool.annotations.destructiveHint) : !tool.annotations.readOnlyHint;
  }

  /** Drops the cached provider client (settings changed). */
  forgetTenant(tenantId: string): void {
    this.clients.delete(tenantId);
  }

  private async client(ctx: CallContext): Promise<DecisionProvider | null> {
    const hit = this.clients.get(ctx.tenantId);
    if (hit && hit.expires > Date.now()) return hit.provider;
    const cfg = await this.deps.settingsRepo.getDecrypted(ctx.tenantId);
    const provider = cfg?.apiKey
      ? this.deps.providers(
          { provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
          effectiveNetworkPolicy(this.deps.allowPrivateNetworks, ctx.snapshot.tenant.settings),
        )
      : null;
    this.clients.set(ctx.tenantId, { provider, expires: Date.now() + CLIENT_TTL_MS });
    return provider;
  }

  /** Free text leaves the gateway only after PII redaction (value detectors). */
  private redact(ctx: CallContext, text: string): Promise<string> {
    return this.deps.pii.redactText({ tenantId: ctx.tenantId, snapshot: ctx.snapshot }, text);
  }

  /**
   * Budget → circuit → timeout → plugins. `pick` combines plugin answers: rerank/shortlist take
   * the first value, the gate the most restrictive. Throws on budget, open circuit or provider error.
   */
  private async consult<T>(
    ctx: CallContext,
    point: RouterPoint,
    provider: DecisionProvider,
    s: ToolRouterSettings,
    hook: (plugin: ToolRouterPlugin, hctx: RouterHookCtx) => Promise<HookResult<T>> | undefined,
    pick: 'first' | ((a: T, b: T) => T),
  ): Promise<HookResult<T>> {
    await this.deps.budget.check([{ scope: 'router', key: `${ctx.tenantId}:router`, limit: { limit: s.maxDecisionsPerMinute, windowSec: 60 } }]);
    const circuitKey = `${ctx.tenantId}:router:${provider.id}`;
    this.deps.circuit.before(circuitKey, provider.id, CIRCUIT);
    const timeout = AbortSignal.timeout(s[point].timeoutMs);
    const hctx: RouterHookCtx = { tenantId: ctx.tenantId, signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout };
    let best: HookResult<T> | undefined;
    let abstained: RouterDecision | undefined;
    try {
      for (const plugin of this.plugins.create(provider, s)) {
        const pending = hook(plugin, hctx);
        if (!pending) continue;
        const r = await pending;
        if (r.value === undefined) {
          abstained ??= r.decision;
          continue;
        }
        if (pick === 'first') {
          best = r;
          break;
        }
        if (!best || pick(best.value!, r.value) !== best.value) best = r;
      }
    } catch (err) {
      this.deps.circuit.failure(circuitKey, CIRCUIT);
      throw err;
    }
    this.deps.circuit.success(circuitKey);
    return best ?? { decision: abstained ?? { plugin: ROUTER_PLUGIN, point, decision: 'skipped', reason: 'invalid' } };
  }

  private fail(ctx: CallContext, point: RouterPoint, err: unknown): RouterReason {
    const reason = failureReason(err);
    if (reason === 'error') this.deps.logger.warn({ tenant: ctx.tenantId, point, code: isGatewayError(err) ? err.code : (err as Error)?.name }, 'tool router fell back');
    return reason;
  }

  private cacheKey(ctx: CallContext, point: 'rerank' | 'shortlist', provider: DecisionProvider, text: string, candidates: string[]): string {
    return decisionCacheKey({
      tenantId: ctx.tenantId,
      point,
      provider: provider.id,
      model: provider.model,
      catalog: `${ctx.snapshot.generation}:${ctx.snapshot.builtAt}`,
      text,
      candidates,
    });
  }

  /** Reorders search candidates (Omni `search_tools`); returns at most `limit` names. */
  async rerank(ctx: CallContext, query: string, candidates: RoutableTool[], limit: number): Promise<RouterResult> {
    const t0 = performance.now();
    const original = candidates.map((c) => c.name);
    const base = { point: 'rerank' as const, candidates: candidates.length };
    const skipped = (reason: RouterReason, extra: Partial<RouterDecision> = {}): RouterResult => ({
      names: original.slice(0, limit),
      applied: false,
      decision: { plugin: ROUTER_PLUGIN, ...base, decision: 'skipped', reason, ...extra, ms: elapsed(t0) },
    });
    if (candidates.length < 2) return skipped('ok');
    const s = this.settings(ctx);
    const provider = await this.client(ctx);
    if (!provider) return skipped('disabled');
    const who = { provider: provider.id, model: provider.model };
    try {
      const text = await this.redact(ctx, query);
      const key = s.cacheTtlSeconds > 0 ? this.cacheKey(ctx, 'rerank', provider, text, original) : undefined;
      const cached = key ? await this.deps.cache.get(key) : undefined;
      if (cached?.length) {
        const names = mergeRanking(original, subsetOf(original, cached), limit);
        return { names, applied: true, decision: { plugin: ROUTER_PLUGIN, ...base, ...who, decision: 'applied', reason: 'ok', cached: true, kept: cached.length, ms: elapsed(t0) } };
      }
      const r = await this.consult(ctx, 'rerank', provider, s, (p, h) => p.rerank?.(h, { query: text, candidates }), 'first');
      const head = r.value ? subsetOf(original, r.value) : [];
      if (!head.length) return { names: original.slice(0, limit), applied: false, decision: { ...r.decision, decision: 'skipped', ms: elapsed(t0) } };
      if (key) await this.deps.cache.set(key, head, s.cacheTtlSeconds);
      return { names: mergeRanking(original, head, limit), applied: true, decision: { ...r.decision, ms: elapsed(t0) } };
    } catch (err) {
      return skipped(this.fail(ctx, 'rerank', err), who);
    }
  }

  /** Narrows the visible tools by the agent intent (`tools/list`); returns names in display order. */
  async shortlist(ctx: CallContext, intent: string, visible: SnapshotTool[]): Promise<RouterResult> {
    const t0 = performance.now();
    const original = visible.map((t) => t.name);
    const s = this.settings(ctx);
    const skipped = (reason: RouterReason, extra: Partial<RouterDecision> = {}): RouterResult => ({
      names: original,
      applied: false,
      decision: { plugin: ROUTER_PLUGIN, point: 'shortlist', decision: 'skipped', reason, candidates: visible.length, ...extra, ms: elapsed(t0) },
    });
    if (!intent.trim()) return skipped('no_intent');
    if (visible.length <= s.shortlist.minTools) return skipped('ok');
    const provider = await this.client(ctx);
    if (!provider) return skipped('disabled');
    const who = { provider: provider.id, model: provider.model };
    try {
      let pool = visible;
      if (s.shortlist.granularity === 'tool' && this.deps.search) {
        pool = (await this.deps.search.search(ctx.tenantId, intent, visible, s.shortlist.candidates)).map((r) => r.tool);
        if (!pool.length) return skipped('none_option', who);
      }
      const text = await this.redact(ctx, intent);
      const poolNames = pool.map((t) => t.name);
      const key = s.cacheTtlSeconds > 0 ? this.cacheKey(ctx, 'shortlist', provider, text, poolNames) : undefined;
      const cached = key ? await this.deps.cache.get(key) : undefined;
      if (cached?.length) {
        const names = subsetOf(original, cached);
        return { names, applied: true, decision: { plugin: ROUTER_PLUGIN, point: 'shortlist', ...who, decision: 'applied', reason: 'ok', cached: true, candidates: visible.length, kept: names.length, ms: elapsed(t0) } };
      }
      const tools = pool.map(toRoutable);
      const r = await this.consult(ctx, 'shortlist', provider, s, (p, h) => p.shortlist?.(h, { intent: text, tools }), 'first');
      const names = r.value ? subsetOf(original, r.value) : [];
      if (!names.length) return { names: original, applied: false, decision: { ...r.decision, decision: 'skipped', ms: elapsed(t0) } };
      if (key) await this.deps.cache.set(key, names, s.cacheTtlSeconds);
      return { names, applied: true, decision: { ...r.decision, kept: names.length, ms: elapsed(t0) } };
    } catch (err) {
      return skipped(this.fail(ctx, 'shortlist', err), who);
    }
  }

  /**
   * Risk gate before the upstream (`tools/call`). Arguments reach the provider PII-redacted (or
   * as names only); the outcome resolves to allow or deny per the tenant settings.
   */
  async gate(ctx: CallContext, tool: SnapshotTool, args: Record<string, unknown>): Promise<GateResult> {
    const t0 = performance.now();
    const g = this.settings(ctx).gate;
    const resolve = (outcome: GateOutcome, decision: RouterDecision): GateResult => {
      const d = { ...decision, ms: elapsed(t0) };
      if (outcome === 'allow') return { outcome, effective: 'allow', decision: d };
      if (outcome === 'deny') return { outcome, effective: 'deny', message: 'router.gateDenied', decision: d };
      return g.onConfirmWithoutUi === 'allow'
        ? { outcome, effective: 'allow', decision: d }
        : { outcome, effective: 'deny', message: 'router.confirmationRequired', decision: d };
    };
    const fallback = (reason: RouterReason, extra: Partial<RouterDecision> = {}) =>
      resolve(g.onError, { plugin: ROUTER_PLUGIN, point: 'gate', decision: g.onError, reason, ...extra });

    // a human already confirmed this exact call through the plan view (ADR-022)
    if (ctx.ui?.confirmed) return resolve('allow', { plugin: ROUTER_PLUGIN, point: 'gate', decision: 'allow', reason: 'human_confirmed' });
    const provider = await this.client(ctx);
    if (!provider) return fallback('disabled');
    const who = { provider: provider.id, model: provider.model };
    try {
      const sent = g.argsMode === 'none' ? Object.keys(args) : await this.deps.pii.redactForLog({ tenantId: ctx.tenantId, snapshot: ctx.snapshot }, tool, args);
      const intent = ctx.intent ? await this.redact(ctx, ctx.intent) : undefined;
      const input = { tool: toRoutable(tool), args: sent, ...(intent ? { intent } : {}) };
      const r = await this.consult(ctx, 'gate', provider, this.settings(ctx), (p, h) => p.gate?.(h, input), mostRestrictive);
      if (r.value === undefined) return fallback(r.decision.reason, who);
      return resolve(r.value, r.decision);
    } catch (err) {
      return fallback(this.fail(ctx, 'gate', err), who);
    }
  }
}
