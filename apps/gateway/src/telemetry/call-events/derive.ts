import { overheadMs, STAGES, type CallEvent } from '@mcp-gateway/call-analytics';
import type { AuditInput, JsonObject } from '@mcp-gateway/db';
import type { Metrics } from '../metrics';
import type { CallRecorder } from './recorder';

/** Audit row derived from the wide event (same shape as before F15; allow now keeps its rule). */
export function toAuditInput(rec: CallRecorder, action: string): AuditInput {
  const ev = rec.ev;
  const details: Record<string, unknown> = { ...(rec.auditDetails ?? {}) };
  if (ev.decision === 'allow' && ev.policyRuleId && details.ruleId === undefined) details.ruleId = ev.policyRuleId;
  return {
    action,
    toolId: ev.toolId ?? null,
    toolName: ev.toolName,
    subject: ev.subject,
    clientId: ev.clientId ?? null,
    decision: ev.decision,
    statusCode: ev.upstreamStatus ?? null,
    latencyMs: Math.round(ev.latencyMs),
    redactionsCount: ev.redactionsCount ?? 0,
    projectedBytesSaved: rec.projectedBytesSaved,
    traceId: ev.traceId ?? ev.requestId ?? null,
    callId: ev.callId,
    parentCallId: ev.parentCallId ?? null,
    artifactId: ev.artifactId ?? null,
    ...(Object.keys(details).length ? { details: details as JsonObject } : {}),
  };
}

/**
 * Prometheus metrics derived from the event (F9.2 names kept). Unknown tools are labelled
 * `unknown`: a requested name is agent input and must not create label cardinality.
 */
export function recordCallMetrics(metrics: Metrics, ev: CallEvent): void {
  const tenant = ev.tenantSlug ?? ev.tenantId;
  const tool = ev.toolId ? ev.toolName : 'unknown';
  if (ev.kind === 'tool') {
    const labels = { tenant, tool, decision: ev.decision };
    metrics.toolCallDuration.observe(labels, ev.latencyMs / 1000);
    metrics.toolCalls.inc(labels);
    for (const stage of STAGES) {
      const ms = ev.stages?.[stage];
      if (ms !== undefined) metrics.stageDuration.observe({ tenant, stage }, ms / 1000);
    }
    if (ev.toolId) metrics.gatewayOverhead.observe({ tenant }, overheadMs(ev) / 1000);
    if (ev.decision !== 'allow' && ev.errorStage) metrics.callErrors.inc({ tenant, stage: ev.errorStage });
  }
  if (ev.tokensSavedProjection) metrics.tokensSaved.inc({ tenant, mechanism: 'projection' }, ev.tokensSavedProjection);
  if (ev.tokensSavedArtifact) metrics.tokensSaved.inc({ tenant, mechanism: 'artifact' }, ev.tokensSavedArtifact);
  if (ev.kind === 'list' && ev.meta?.fullCatalogTokens != null && ev.catalogTokens != null) {
    // the router shortlist reduces the native list; Omni replaces it with meta-tools
    const saved = ev.meta.fullCatalogTokens - ev.catalogTokens;
    if (saved > 0) metrics.tokensSaved.inc({ tenant, mechanism: ev.viaOmni ? 'omni' : 'shortlist' }, saved);
  }
  for (const d of ev.plugins ?? []) {
    const point = d.point ?? 'unknown';
    const provider = d.provider ?? 'none';
    metrics.routerDecisions.inc({ tenant, point, provider, decision: d.decision, reason: d.reason ?? 'ok' });
    if (d.ms !== undefined) metrics.routerDuration.observe({ tenant, point, provider }, d.ms / 1000);
  }
  for (const [detector, n] of Object.entries(ev.redactionsByDetector ?? {})) metrics.redactions.inc({ tenant, detector }, n);
  if (ev.bytesBeforeProjection != null && ev.bytesAfterProjection != null) {
    metrics.projectionBytesSaved.inc({ tenant, tool }, Math.max(0, ev.bytesBeforeProjection - ev.bytesAfterProjection));
  }
  if (ev.artifactBytes) metrics.artifactBytes.inc({ tenant, tool }, ev.artifactBytes);
}
