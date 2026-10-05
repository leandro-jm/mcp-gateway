import { trace } from '@opentelemetry/api';
import type { CallEvent } from '@mcp-gateway/call-analytics';
import { NotFound } from '@mcp-gateway/core';
import type { Locale } from '@mcp-gateway/i18n';
import type { Principal } from '../auth/tokens';
import { CircuitBreaker } from '../proxy/guards';
import { ToolExecutor, type CallContext } from '../proxy/executor';
import { RecordedUpstreamAdapter } from '../proxy/recorded-adapter';
import type { ToolResult } from '../proxy/result';
import { ArgValidator } from '../proxy/validation';
import type { Services } from '../services';
import { MemoryCallEventSink } from '../telemetry/call-events/sink';
import { Metrics } from '../telemetry/metrics';

const resultBytes = (r: unknown) => Buffer.byteLength(JSON.stringify(r ?? null));

function summary(decision: string, redactions: number | null | undefined, bytes: number | null | undefined, tokens: number | null | undefined) {
  return { decision, redactions: redactions ?? 0, responseBytes: bytes ?? null, responseTokens: tokens ?? null };
}

/**
 * Replay-mock (F15.18): re-runs a captured call through the pipeline with the current tenant
 * configuration (policies, PII rules, projection) over the recorded upstream response. It never
 * calls the upstream, applies no rate limit or circuit breaker, persists no artifact and writes no
 * call event; the audit row is `tools/replay`.
 */
export async function replayCall(services: Services, tenantId: string, callId: string, locale: Locale, actor: string) {
  const captured = await services.debug.read(tenantId, callId);
  if (!captured) throw new NotFound('call', callId);
  const snapshot = await services.registry.get(tenantId);
  const sink = new MemoryCallEventSink();
  const executor = new ToolExecutor({
    adapter: new RecordedUpstreamAdapter(captured),
    validator: new ArgValidator(),
    rateLimiter: { check: async () => undefined },
    circuit: new CircuitBreaker(),
    audit: {
      record: (t, ev) =>
        services.repos.audit.record(t, { ...ev, action: ev.action === 'tools/call' ? 'tools/replay' : `${ev.action}.replay`, details: { ...(ev.details ?? {}), replayOf: callId, replayBy: actor } }),
    },
    pii: services.pii,
    artifacts: { enabled: false, shouldOffload: () => false, offload: () => Promise.reject(new Error('no offload in replay')), resolveRefs: async (_c, args) => ({ args, resolved: 0 }) },
    logger: services.logger,
    metrics: new Metrics(),
    tracer: trace.getTracer('mcp-gateway-replay'),
    sink,
    allowPrivateNetworks: false,
  });
  const p = captured.principal;
  const principal: Principal = { sub: p.sub, tenant: snapshot.tenant.slug, roles: p.roles, groups: p.groups, clientId: p.clientId, claims: p.claims, locale };
  const ctx: CallContext = { tenantId, principal, snapshot, identity: { endpoint: 'api', sessionSource: 'principal' } };
  const { _output: _ignored, ...args } = (captured.args ?? {}) as Record<string, unknown>;

  let replayed: ToolResult | { error: string };
  try {
    replayed = await executor.call(ctx, captured.tool, args);
  } catch (err) {
    replayed = { error: (err as Error).message };
  }
  const ev: CallEvent | undefined = sink.events.find((e) => e.event.kind === 'tool')?.event;
  // the original event may still be in the analytics buffer
  await services.callEvents.flush();
  const original = await services.repos.callEvents.get(tenantId, callId);
  const before = original
    ? summary(original.decision, original.redactionsCount, original.responseBytes, original.responseTokens)
    : summary('unknown', null, resultBytes(captured.final), null);
  const after = summary(ev?.decision ?? 'error', ev?.redactionsCount, ev?.responseBytes, ev?.responseTokens);
  const wouldOffload = ev?.bytesAfterProjection != null && services.artifacts.shouldOffload({ tenantId, sessionKey: 'replay', snapshot, locale }, ev.bytesAfterProjection, false);
  const diff = (a: number | null, b: number | null) => (a == null || b == null ? null : b - a);
  return {
    callId,
    tool: captured.tool,
    original: { ...before, final: captured.final },
    replayed: { ...after, final: replayed, wouldOffload, policyRuleId: ev?.policyRuleId ?? null, bytesBeforeProjection: ev?.bytesBeforeProjection ?? null, bytesAfterProjection: ev?.bytesAfterProjection ?? null },
    deltas: {
      decisionChanged: before.decision !== 'unknown' && before.decision !== after.decision,
      redactions: after.redactions - before.redactions,
      responseBytes: diff(before.responseBytes, after.responseBytes),
      responseTokens: diff(before.responseTokens, after.responseTokens),
    },
  };
}
