/**
 * Measures the tool router rerank with a real decision provider on the F7.1 evaluation set
 * (200 synthetic tools, `SEARCH_EVAL`): FTS alone vs FTS + decision model, plus latency.
 *
 *   ROUTER_EVAL_PROVIDER=openai_decisions ROUTER_EVAL_API_KEY=sk-... pnpm --filter @mcp-gateway/gateway router-eval
 *
 * Needs the dev stack (`pnpm dev:infra`) and the gateway env (`.env`). Optional:
 * ROUTER_EVAL_MODEL, ROUTER_EVAL_BASE_URL, ROUTER_EVAL_CANDIDATES (20), ROUTER_EVAL_MIN_CONFIDENCE (0.35).
 * Seeds a `router-eval` tenant once. Queries are synthetic: no tenant data is sent to the provider.
 */
import { readToolRouterSettings } from '@mcp-gateway/core';
import { migrateUp } from '@mcp-gateway/db';
import { SEARCH_EVAL, syntheticTools } from '@mcp-gateway/testkit';
import { createDecisionModelPlugin, DECISION_PROVIDERS, DEFAULT_DECISION_MODELS, mergeRanking, subsetOf, type DecisionProvider, type DecisionProviderId } from '@mcp-gateway/tool-router';
import { loadConfig } from '../src/config';
import { createLogger } from '../src/logger';
import { createDecisionProvider, decisionModelOptions, toRoutable } from '../src/router';
import { createServices } from '../src/services';

const env = process.env;
const providerId = (env.ROUTER_EVAL_PROVIDER ?? 'openai_decisions') as DecisionProviderId;
if (!DECISION_PROVIDERS.includes(providerId)) throw new Error(`ROUTER_EVAL_PROVIDER must be one of ${DECISION_PROVIDERS.join(', ')}`);
if (!env.ROUTER_EVAL_API_KEY) throw new Error('ROUTER_EVAL_API_KEY is required');
const candidates = Number(env.ROUTER_EVAL_CANDIDATES ?? 20);
const out = (line = '') => process.stdout.write(`${line}\n`);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? 0;

const config = loadConfig(env);
const services = createServices(config, createLogger('warn'));
await migrateUp(services.dbHandle.pool);

const tenant = (await services.repos.tenants.findBySlug('router-eval')) ?? (await services.repos.tenants.create({ slug: 'router-eval', name: 'Router evaluation' }));
if (!(await services.repos.tools.findByName(tenant.id, 'rh_ferias_list'))) {
  for (const t of syntheticTools()) await services.repos.tools.create(tenant.id, { kind: 'manual', ...t, state: 'enabled' });
  await services.registry.invalidate(tenant.id);
}
const snapshot = await services.registry.get(tenant.id);

// counts what each decision costs, without touching the plugin
let inputTokens = 0;
const real = createDecisionProvider(
  { provider: providerId, model: env.ROUTER_EVAL_MODEL ?? DEFAULT_DECISION_MODELS[providerId], baseUrl: env.ROUTER_EVAL_BASE_URL ?? null, apiKey: env.ROUTER_EVAL_API_KEY },
  { allowPrivate: config.NETWORK_ALLOW_PRIVATE, allowedHosts: [] },
);
const provider: DecisionProvider = {
  id: real.id,
  model: real.model,
  ping: (s) => real.ping(s),
  async decide(req, signal) {
    const res = await real.decide(req, signal);
    inputTokens += res.inputTokens ?? Math.ceil(JSON.stringify(req).length / 4);
    return res;
  },
};
const settings = readToolRouterSettings({ toolRouter: { rerank: { minConfidence: Number(env.ROUTER_EVAL_MIN_CONFIDENCE ?? 0.35) } } });
const plugin = createDecisionModelPlugin(provider, decisionModelOptions(settings));

let recall = 0;
const fts = { top1: 0, top3: 0 };
const routed = { top1: 0, top3: 0 };
const reasons: Record<string, number> = {};
const latencies: number[] = [];
const misses: string[] = [];
for (const { query, expected } of SEARCH_EVAL) {
  const pool = (await services.search.search(tenant.id, query, snapshot.tools, candidates)).map((r) => r.tool);
  const original = pool.map((t) => t.name);
  if (original.includes(expected)) recall++;
  if (original[0] === expected) fts.top1++;
  if (original.slice(0, 3).includes(expected)) fts.top3++;
  const t0 = performance.now();
  let names = original.slice(0, 3);
  try {
    const r = await plugin.rerank!({ tenantId: tenant.id, signal: AbortSignal.timeout(10_000) }, { query, candidates: pool.map(toRoutable) });
    reasons[r.decision.reason] = (reasons[r.decision.reason] ?? 0) + 1;
    if (r.value) names = mergeRanking(original, subsetOf(original, r.value), 3);
  } catch (err) {
    reasons.error = (reasons.error ?? 0) + 1;
    misses.push(`${query}: ${(err as Error).message}`);
  }
  latencies.push(performance.now() - t0);
  if (names[0] === expected) routed.top1++;
  if (names.includes(expected)) routed.top3++;
  else misses.push(`${query} → expected ${expected}, got ${names.join(', ')}`);
}

const n = SEARCH_EVAL.length;
out(`provider: ${provider.id} (${provider.model}), ${n} queries, ${candidates} candidates`);
out(`recall@${candidates} (ceiling): ${pct(recall / n)}`);
out(`FTS:            top-1 ${pct(fts.top1 / n)}  top-3 ${pct(fts.top3 / n)}`);
out(`FTS + decision: top-1 ${pct(routed.top1 / n)}  top-3 ${pct(routed.top3 / n)}`);
out(`latency: p50 ${quantile(latencies, 0.5).toFixed(0)} ms, p95 ${quantile(latencies, 0.95).toFixed(0)} ms`);
out(`input tokens: ${inputTokens} total, ${Math.round(inputTokens / n)} per decision`);
out(`reasons: ${JSON.stringify(reasons)}`);
if (misses.length) out(`\nmisses:\n${misses.join('\n')}`);
await services.close();
