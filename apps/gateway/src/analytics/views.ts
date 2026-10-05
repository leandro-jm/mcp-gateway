import {
  anomalyScores,
  LAST,
  priceTokens,
  type AnalyticsScope,
  type Dimension,
  type FilterKey,
  type LastRange,
  type Metric,
  type NormalizedQuery,
  type QueryRow,
} from '@mcp-gateway/call-analytics';
import { readObservabilitySettings } from '@mcp-gateway/core';
import type { RegistrySnapshot } from '../registry/snapshot';
import type { Services } from '../services';

/**
 * Views per audience (F15.12): SRE, tool owner, security and FinOps. Shared by the Admin API and
 * the observability MCP, so both always return the same numbers.
 */
export interface ViewRange {
  from: Date;
  to: Date;
}

export function rangeOf(last: LastRange = '7d', now = new Date()): ViewRange {
  return { from: new Date(now.getTime() - LAST[last]), to: now };
}

const DAY = 86_400_000;
const INTERNAL_LIMIT = 5000;

/** Internal query: whitelisted metric and dimensions, no user input in identifiers. */
function nq(metric: Metric, r: ViewRange, groupBy: Dimension[] = [], filters: Partial<Record<FilterKey, string[]>> = {}, limit = 20): NormalizedQuery {
  return { metric, groupBy, filters, from: r.from, to: r.to, limit, order: 'desc' };
}

const timeDimension = (r: ViewRange): Dimension => (r.to.getTime() - r.from.getTime() > 7 * DAY ? 'day' : 'hour');

const scalar = (rows: QueryRow[]) => rows[0]?.value ?? null;

/** Merges several single-dimension series into one row per key. */
function mergeBy(dim: string, series: Record<string, QueryRow[]>): Array<Record<string, string | number | null>> {
  const out = new Map<string | null, Record<string, string | number | null>>();
  for (const [name, rows] of Object.entries(series)) {
    for (const r of rows) {
      const key = r.keys[dim] ?? null;
      const row = out.get(key) ?? { [dim]: key };
      row[name] = r.value;
      out.set(key, row);
    }
  }
  return [...out.values()];
}

const sourceName = (snapshot: RegistrySnapshot, id: string | null) => (id ? (snapshot.sources.find((s) => s.id === id)?.name ?? id) : null);

export async function sreView(services: Services, tenantId: string, r: ViewRange) {
  const a = services.analytics;
  const snapshot = await services.registry.get(tenantId);
  const t = timeDimension(r);
  const [calls, errorRate, p95, overhead, upstream, overTimeP95, overTimeOverhead, overTimeUpstream, overTimeCalls, bySource, byStage, circuit, stages] = await Promise.all([
    a.query(tenantId, nq('calls', r)),
    a.query(tenantId, nq('error_rate', r)),
    a.query(tenantId, nq('latency_p95', r)),
    a.query(tenantId, nq('overhead_p95', r)),
    a.query(tenantId, nq('upstream_avg', r)),
    a.query(tenantId, nq('latency_p95', r, [t], {}, INTERNAL_LIMIT)),
    a.query(tenantId, nq('overhead_p95', r, [t], {}, INTERNAL_LIMIT)),
    a.query(tenantId, nq('upstream_avg', r, [t], {}, INTERNAL_LIMIT)),
    a.query(tenantId, nq('calls', r, [t], {}, INTERNAL_LIMIT)),
    // errors caused by the source itself (not validation or authorization)
    a.query(tenantId, nq('calls', r, ['source'], { decision: ['error'], error_stage: ['upstream', 'circuit'] }, 50)),
    a.query(tenantId, nq('calls', r, ['error_stage'], { decision: ['error', 'deny'] }, 50)),
    a.query(tenantId, nq('calls', r, ['source'], { error_code: ['CIRCUIT_OPEN'] }, 50)),
    Promise.all(
      (['authz_avg', 'validation_avg', 'pii_avg', 'upstream_avg', 'projection_avg', 'artifact_avg'] as const).map(async (m) => [m.replace('_avg', ''), scalar((await a.query(tenantId, nq(m, r))).rows)] as const),
    ),
  ]);
  return {
    from: r.from.toISOString(),
    to: r.to.toISOString(),
    totals: {
      calls: scalar(calls.rows) ?? 0,
      errorRate: scalar(errorRate.rows),
      latencyP95: scalar(p95.rows),
      overheadP95: scalar(overhead.rows),
      upstreamAvg: scalar(upstream.rows),
    },
    overTime: mergeBy(t, { calls: overTimeCalls.rows, latencyP95: overTimeP95.rows, overheadP95: overTimeOverhead.rows, upstreamAvg: overTimeUpstream.rows }).map((row) => ({
      ts: row[t] as string,
      calls: (row.calls as number) ?? 0,
      latencyP95: (row.latencyP95 as number) ?? null,
      overheadP95: (row.overheadP95 as number) ?? null,
      upstreamAvg: (row.upstreamAvg as number) ?? null,
    })),
    errorsBySource: bySource.rows.map((x) => ({ source: sourceName(snapshot, x.keys.source ?? null), calls: x.value ?? 0 })),
    errorsByStage: byStage.rows.map((x) => ({ stage: x.keys.error_stage ?? null, calls: x.value ?? 0 })),
    circuitOpen: circuit.rows.map((x) => ({ source: sourceName(snapshot, x.keys.source ?? null), calls: x.value ?? 0 })),
    stages: Object.fromEntries(stages),
  };
}

export async function toolsView(services: Services, tenantId: string, r: ViewRange, scope: AnalyticsScope = {}) {
  const a = services.analytics;
  const snapshot = await services.registry.get(tenantId);
  const [calls, errors, agents, retries, validation, byAgent, used] = await Promise.all([
    a.query(tenantId, nq('calls', r, ['tool'], {}, 100), scope),
    a.query(tenantId, nq('errors', r, ['tool'], {}, 100), scope),
    a.query(tenantId, nq('agents', r, ['tool'], {}, 100), scope),
    a.query(tenantId, nq('retries', r, ['tool'], {}, 100), scope),
    a.query(tenantId, nq('calls', r, ['tool'], { error_stage: ['validation'] }, 100), scope),
    a.query(tenantId, nq('calls', r, ['tool', 'agent'], {}, 100), scope),
    a.query(tenantId, nq('calls', r, ['tool'], {}, INTERNAL_LIMIT), scope),
  ]);
  const usage = mergeBy('tool', { calls: calls.rows, errors: errors.rows, agents: agents.rows, retries: retries.rows, validationErrors: validation.rows })
    .filter((row) => row.calls != null)
    .map((row) => ({
      tool: row.tool as string,
      calls: (row.calls as number) ?? 0,
      errors: (row.errors as number) ?? 0,
      agents: (row.agents as number) ?? 0,
      retries: (row.retries as number) ?? 0,
      validationErrors: (row.validationErrors as number) ?? 0,
    }));
  const usedNames = new Set(used.rows.map((x) => x.keys.tool));
  const visible = snapshot.tools.filter((tool) => !scope.toolNames || scope.toolNames.includes(tool.name));
  const neverUsed = visible
    .filter((tool) => tool.state === 'enabled' && !usedNames.has(tool.name))
    .map((tool) => ({ tool: tool.name, kind: tool.kind, ownerTeam: tool.ownerTeam ?? null }));

  // drift impact: error rate in the 7 days before and after each change
  const drifts = (await services.repos.drift.list(tenantId, { limit: 50 })).filter((d) => d.createdAt >= r.from && d.createdAt < r.to);
  const driftImpact = [];
  for (const d of drifts) {
    const tool = snapshot.tools.find((x) => x.id === d.toolId);
    if (!tool || (scope.toolNames && !scope.toolNames.includes(tool.name))) continue;
    const at = d.createdAt.getTime();
    const before = { from: new Date(at - 7 * DAY), to: d.createdAt };
    const after = { from: d.createdAt, to: new Date(Math.min(at + 7 * DAY, Date.now())) };
    const [b, af] = await Promise.all([
      a.query(tenantId, nq('error_rate', before, [], { tool: [tool.name] })),
      a.query(tenantId, nq('error_rate', after, [], { tool: [tool.name] })),
    ]);
    driftImpact.push({ tool: tool.name, kind: d.kind, at: d.createdAt.toISOString(), errorRateBefore: scalar(b.rows), errorRateAfter: scalar(af.rows) });
  }
  return {
    from: r.from.toISOString(),
    to: r.to.toISOString(),
    usage,
    byAgent: byAgent.rows.map((x) => ({ tool: x.keys.tool ?? null, agent: x.keys.agent ?? null, calls: x.value ?? 0 })),
    neverUsed,
    driftImpact,
  };
}

export async function securityView(services: Services, tenantId: string, r: ViewRange, now = new Date()) {
  const a = services.analytics;
  const history: ViewRange = { from: new Date(now.getTime() - 29 * DAY), to: now };
  const [denials, denialsByRule, detectors, byClient, byAgent] = await Promise.all([
    a.query(tenantId, nq('calls', r, ['tool'], { decision: ['deny'] }, 50)),
    a.denialsByRule(tenantId, r.from, r.to, 50),
    a.detectorCounts(tenantId, r.from, r.to),
    a.query(tenantId, nq('calls', history, ['hour', 'client'], {}, INTERNAL_LIMIT)),
    a.query(tenantId, nq('calls', history, ['hour', 'agent'], {}, INTERNAL_LIMIT)),
  ]);
  const hourly = (rows: QueryRow[], dim: 'client' | 'agent') =>
    rows.filter((x) => x.keys[dim]).map((x) => ({ key: x.keys[dim]!, hour: new Date(x.keys.hour!), calls: x.value ?? 0 }));
  return {
    from: r.from.toISOString(),
    to: r.to.toISOString(),
    denials: denials.rows.map((x) => ({ tool: x.keys.tool ?? null, calls: x.value ?? 0 })),
    denialsByRule,
    redactionsByDetector: detectors,
    anomalies: [
      ...anomalyScores(hourly(byClient.rows, 'client'), now).map((x) => ({ ...x, dimension: 'client' as const })),
      ...anomalyScores(hourly(byAgent.rows, 'agent'), now).map((x) => ({ ...x, dimension: 'agent' as const })),
    ],
    // reserved until the confirm gate, cross-server flows and pinning exist (ADR-016 §2)
    confirms: [],
    blockedFlows: [],
    pinningViolations: [],
  };
}

export async function finopsView(services: Services, tenantId: string, r: ViewRange) {
  const a = services.analytics;
  const snapshot = await services.registry.get(tenantId);
  const pricing = readObservabilitySettings(snapshot.tenant.settings).pricing;
  const [response, projection, artifact, omni, byClient, byAgent, bySubject] = await Promise.all([
    a.query(tenantId, nq('tokens_response', r, [], { kind: ['tool', 'meta', 'list', 'artifact'] })),
    a.query(tenantId, nq('tokens_saved_projection', r)),
    a.query(tenantId, nq('tokens_saved_artifact', r)),
    a.query(tenantId, nq('tokens_saved_omni', r)),
    a.usageBy(tenantId, 'client', r.from, r.to, 50),
    a.usageBy(tenantId, 'agent', r.from, r.to, 50),
    a.usageBy(tenantId, 'subject', r.from, r.to, 50),
  ]);
  const saved = { projection: scalar(projection.rows) ?? 0, artifact: scalar(artifact.rows) ?? 0, omni: scalar(omni.rows) ?? 0 };
  const totalSaved = saved.projection + saved.artifact + saved.omni;
  const used = scalar(response.rows) ?? 0;
  const without = used + totalSaved;
  return {
    from: r.from.toISOString(),
    to: r.to.toISOString(),
    pricing,
    tokens: { response: used, saved: totalSaved, savedByMechanism: saved },
    money: { currency: pricing.currency, saved: priceTokens(totalSaved, pricing), spent: priceTokens(used, pricing) },
    beforeAfter: {
      withoutGateway: without,
      withGateway: used,
      savedPct: without ? Math.round((totalSaved / without) * 1000) / 10 : 0,
      moneySaved: priceTokens(totalSaved, pricing),
    },
    usageByClient: byClient,
    usageByAgent: byAgent,
    usageBySubject: bySubject,
  };
}

export interface TopFailingOptions {
  limit?: number;
  groupBy?: 'source' | 'agent';
}

/**
 * Tools with the most errors (observability MCP and Admin API): error rate, dominant error code
 * and stage, and the trend against the previous period of the same length.
 */
export async function topFailingTools(services: Services, tenantId: string, r: ViewRange, opts: TopFailingOptions = {}) {
  const a = services.analytics;
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const span = r.to.getTime() - r.from.getTime();
  const previous: ViewRange = { from: new Date(r.from.getTime() - span), to: r.from };
  const snapshot = await services.registry.get(tenantId);
  const [errors, calls, rates, prevRates, codes, stages, breakdown, success] = await Promise.all([
    a.query(tenantId, nq('errors', r, ['tool'], {}, INTERNAL_LIMIT)),
    a.query(tenantId, nq('calls', r, ['tool'], {}, INTERNAL_LIMIT)),
    a.query(tenantId, nq('error_rate', r, ['tool'], {}, INTERNAL_LIMIT)),
    a.query(tenantId, nq('error_rate', previous, ['tool'], {}, INTERNAL_LIMIT)),
    a.query(tenantId, nq('calls', r, ['tool', 'error_code'], { decision: ['error'] }, INTERNAL_LIMIT)),
    a.query(tenantId, nq('calls', r, ['tool', 'error_stage'], { decision: ['error'] }, INTERNAL_LIMIT)),
    opts.groupBy ? a.query(tenantId, nq('calls', r, ['tool', opts.groupBy], { decision: ['error'] }, INTERNAL_LIMIT)) : undefined,
    a.query(tenantId, nq('success_rate', r, ['tool'], {}, 100)),
  ]);
  const successBy = new Map(success.rows.map((x) => [x.keys.tool ?? '', x.value]));
  const byTool = (rows: QueryRow[]) => new Map(rows.map((x) => [x.keys.tool ?? '', x.value ?? 0]));
  const callsBy = byTool(calls.rows);
  const rateBy = byTool(rates.rows);
  const prevBy = new Map(prevRates.rows.map((x) => [x.keys.tool ?? '', x.value]));
  const dominant = (rows: QueryRow[], dim: string) => {
    const best = new Map<string, { key: string | null; n: number }>();
    for (const x of rows) {
      const tool = x.keys.tool ?? '';
      const cur = best.get(tool);
      if (!cur || (x.value ?? 0) > cur.n) best.set(tool, { key: x.keys[dim] ?? null, n: x.value ?? 0 });
    }
    return best;
  };
  const code = dominant(codes.rows, 'error_code');
  const stage = dominant(stages.rows, 'error_stage');
  const dim = opts.groupBy;
  const label = (v: string | null) => (dim === 'source' ? sourceName(snapshot, v) : v);
  const tools = errors.rows
    .filter((x) => (x.value ?? 0) > 0)
    .sort((x, y) => (y.value ?? 0) - (x.value ?? 0))
    .slice(0, limit)
    .map((x) => {
      const tool = x.keys.tool ?? '';
      const errorRate = rateBy.get(tool) ?? null;
      const previousErrorRate = prevBy.get(tool) ?? null;
      const trend = previousErrorRate == null || errorRate == null ? 'new' : errorRate > previousErrorRate * 1.1 ? 'up' : errorRate < previousErrorRate * 0.9 ? 'down' : 'flat';
      return {
        tool,
        calls: callsBy.get(tool) ?? 0,
        errors: x.value ?? 0,
        errorRate,
        previousErrorRate,
        trend,
        topErrorCode: code.get(tool)?.key ?? null,
        topErrorStage: stage.get(tool)?.key ?? null,
        // real success rate from report_outcome (F15.22), when clients report it
        successRate: successBy.get(tool) ?? null,
        ...(breakdown && dim
          ? { by: breakdown.rows.filter((b) => b.keys.tool === tool).map((b) => ({ [dim]: label(b.keys[dim] ?? null), errors: b.value ?? 0 })) }
          : {}),
      };
    });
  return { from: r.from.toISOString(), to: r.to.toISOString(), tools };
}
