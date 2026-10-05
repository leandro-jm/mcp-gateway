import type { CallEventRow } from '@mcp-gateway/db';
import { authorize } from '../auth/authorizer';
import type { Principal } from '../auth/tokens';
import type { Services } from '../services';

/** Call event as the Admin API and the observability MCP show it (never payloads). */
export function callDto(r: CallEventRow) {
  return {
    ts: r.ts.toISOString(),
    callId: r.callId,
    parentCallId: r.parentCallId,
    kind: r.kind,
    endpoint: r.endpoint,
    subject: r.subject,
    clientId: r.clientId,
    agentName: r.agentName,
    agentVersion: r.agentVersion,
    sessionKey: r.sessionKey,
    sessionSource: r.sessionSource,
    virtualServerId: r.virtualServerId,
    traceId: r.traceId,
    tool: { id: r.toolId, name: r.toolName, version: r.toolVersion, kind: r.toolKind, sourceId: r.sourceId, viaOmni: r.viaOmni },
    decision: r.decision,
    error: r.errorCode ? { code: r.errorCode, stage: r.errorStage, key: r.errorKey } : null,
    upstream: { status: r.upstreamStatus, attempts: r.attempts },
    latencyMs: r.latencyMs,
    overheadMs: r.overheadMs,
    redactionsCount: r.redactionsCount,
    responseTokens: r.responseTokens,
    tokensSaved: r.tokensSavedProjection + r.tokensSavedArtifact,
    meta: r.meta,
  };
}

const STAGE_COLUMNS = [
  ['authz', 'authzMs'],
  ['validation', 'validationMs'],
  ['pii', 'piiMs'],
  ['upstream', 'upstreamMs'],
  ['projection', 'projectionMs'],
  ['artifact', 'artifactMs'],
] as const;

/**
 * Policy now: the current tenant policies evaluated for the subject's current roles (visibility
 * mode: the arguments are never stored, so argument conditions cannot be replayed).
 */
async function currentDecision(services: Services, tenantId: string, r: CallEventRow) {
  const snapshot = await services.registry.get(tenantId);
  const tool = snapshot.tools.find((t) => t.id === r.toolId);
  const user = await services.repos.auth.findUser(r.subject);
  if (!tool || !user || user.tenantId !== tenantId) return null;
  const principal: Principal = {
    sub: user.username,
    tenant: snapshot.tenant.slug,
    roles: user.roles,
    groups: user.groups,
    claims: user.attributes as Principal['claims'],
    clientId: r.clientId ?? undefined,
    locale: user.locale,
  };
  const d = authorize(snapshot, principal, tool, 'list');
  return { effect: d.effect, ruleId: d.ruleId ?? null, reason: d.reason, policyVersion: services.executor.policyVersionOf(snapshot) };
}

/**
 * Explains one call (F15.13): stage waterfall, the policy rule that decided it (with the trace on
 * deny) and whether it would still decide the same, what was redacted, how much projection cut,
 * tokens, composite steps and the linked audit row. Returns `undefined` when the call is unknown.
 */
export async function explainCall(services: Services, tenantId: string, callId: string) {
  const r = await services.repos.callEvents.get(tenantId, callId);
  if (!r) return undefined;
  const [children, audit, now] = await Promise.all([
    services.repos.callEvents.children(tenantId, callId),
    services.repos.audit.list(tenantId, { from: new Date(r.ts.getTime() - 60_000), to: new Date(r.ts.getTime() + 3_600_000), limit: 200 }).then((rows) => rows.find((a) => a.callId === callId)),
    currentDecision(services, tenantId, r),
  ]);
  const before = r.bytesBeforeProjection;
  const after = r.bytesAfterProjection;
  const template = services.config.TRACE_UI_URL_TEMPLATE;
  return {
    call: callDto(r),
    stages: [
      ...STAGE_COLUMNS.filter(([, col]) => r[col] != null).map(([stage, col]) => ({ stage, ms: r[col] as number })),
      { stage: 'overhead', ms: r.overheadMs ?? 0 },
    ],
    policy: {
      decision: r.decision,
      ruleId: r.policyRuleId,
      reason: r.policyReason,
      version: r.policyVersion,
      trace: r.policyTrace,
      current: now,
      policyChanged: now ? now.policyVersion !== r.policyVersion : null,
    },
    data: {
      redactionsCount: r.redactionsCount,
      redactionsByDetector: r.redactionsByDetector ?? {},
      detokenized: r.detokenizedCount,
      subjectRefs: r.subjectRefsCount,
      bytes: { request: r.requestBytes, upstream: r.upstreamBytes, beforeProjection: before, afterProjection: after, response: r.responseBytes },
      projection: before != null && after != null ? { cutBytes: before - after, cutPct: before ? Math.round(((before - after) / before) * 1000) / 10 : 0, ...(r.projection ?? {}) } : null,
      artifact: r.artifactId ? { id: r.artifactId, bytes: r.artifactBytes } : null,
    },
    tokens: { definition: r.defTokens, response: r.responseTokens, raw: r.rawTokens, savedProjection: r.tokensSavedProjection, savedArtifact: r.tokensSavedArtifact },
    children: children.map(callDto),
    audit: audit ? { id: audit.id, action: audit.action, decision: audit.decision, details: audit.details ?? null } : null,
    traceUrl: template && r.traceId ? template.replace('{traceId}', r.traceId) : null,
  };
}

export type CallExplanation = NonNullable<Awaited<ReturnType<typeof explainCall>>>;
