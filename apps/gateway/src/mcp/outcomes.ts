import { isGatewayError, readObservabilitySettings, ValidationError } from '@mcp-gateway/core';
import type { Locale } from '@mcp-gateway/i18n';
import { msg, translate, type ServerMessageKey } from '@mcp-gateway/i18n/server';
import type { CallContext } from '../proxy/executor';
import type { ToolResult } from '../proxy/result';
import { sanitizeIdentity, sanitizeSubject, type Services } from '../services';

/** Task outcome reported by the client (F15.22, ADR-016 §14). Enums only: no free text (PII risk). */
export const OUTCOMES = ['success', 'partial', 'failure', 'abandoned'] as const;
export const REASON_CODES = ['completed', 'wrong_tool', 'wrong_data', 'tool_error', 'permission_denied', 'timeout', 'user_cancelled', 'other'] as const;
export const REPORT_OUTCOME = 'report_outcome';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CALLS = 50;
const IMPLICIT_WINDOW_MS = 2 * 3_600_000;
const EXPLICIT_LOOKBACK_MS = 24 * 3_600_000;

export interface OutcomeInput {
  outcome: (typeof OUTCOMES)[number];
  reasonCode?: (typeof REASON_CODES)[number];
  callIds?: string[];
}

/** Where the meta-tool is advertised (tenant setting `observability.outcomeTool`). */
export function outcomeToolEnabled(ctx: CallContext, where: 'omni' | 'native'): boolean {
  const mode = readObservabilitySettings(ctx.snapshot.tenant.settings).outcomeTool;
  return mode === 'all' || (mode === 'omni' && where === 'omni');
}

export function reportOutcomeTool(locale: Locale) {
  const t = (key: ServerMessageKey) => translate(msg(key), locale);
  return {
    name: REPORT_OUTCOME,
    title: t('mcp.reportOutcomeTitle'),
    description: t('mcp.reportOutcomeDescription'),
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: [...OUTCOMES], description: t('mcp.reportOutcomeOutcomeDescription') },
        reason_code: { type: 'string', enum: [...REASON_CODES], description: t('mcp.reportOutcomeReasonDescription') },
        call_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: MAX_CALLS, description: t('mcp.reportOutcomeCallIdsDescription') },
      },
      required: ['outcome'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
  };
}

/** Validates the body of the meta-tool or of `POST /v1/outcomes` (snake or camel case). */
export function parseOutcome(raw: unknown): OutcomeInput {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const outcome = b.outcome;
  if (typeof outcome !== 'string' || !(OUTCOMES as readonly string[]).includes(outcome)) throw new ValidationError(msg('analytics.invalidOutcome', { reason: `outcome: ${OUTCOMES.join(', ')}` }));
  const reason = b.reason_code ?? b.reasonCode;
  if (reason !== undefined && (typeof reason !== 'string' || !(REASON_CODES as readonly string[]).includes(reason))) {
    throw new ValidationError(msg('analytics.invalidOutcome', { reason: `reason_code: ${REASON_CODES.join(', ')}` }));
  }
  const ids = b.call_ids ?? b.callIds;
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > MAX_CALLS || !ids.every((x) => typeof x === 'string' && UUID_RE.test(x)))) {
    throw new ValidationError(msg('analytics.invalidOutcome', { reason: `call_ids: up to ${MAX_CALLS} uuids` }));
  }
  return { outcome: outcome as OutcomeInput['outcome'], ...(reason ? { reasonCode: reason as OutcomeInput['reasonCode'] } : {}), ...(ids?.length ? { callIds: ids as string[] } : {}) };
}

/**
 * Stores an outcome linked to calls: the explicit `call_ids` (same tenant and subject, last 24 h)
 * or else the calls of the session since its previous outcome (at most 50 calls and 2 h).
 */
export async function reportOutcome(services: Services, ctx: CallContext, input: OutcomeInput, source: 'tool' | 'api') {
  const repo = services.repos.agentAnalytics;
  const subject = sanitizeSubject(ctx.principal.sub);
  const now = Date.now();
  let calls: Array<{ callId: string; toolName: string; virtualServerId: string | null }>;
  await services.callEvents.flush();
  if (input.callIds?.length) {
    const found = await repo.callsByIds(ctx.tenantId, input.callIds, new Date(now - EXPLICIT_LOOKBACK_MS));
    if (found.length !== new Set(input.callIds).size || found.some((c) => c.subject !== subject)) throw new ValidationError(msg('analytics.outcomeForeignCalls'));
    calls = found;
  } else if (ctx.sessionKey) {
    const last = await repo.lastOutcome(ctx.tenantId, ctx.sessionKey);
    const since = new Date(Math.max(now - IMPLICIT_WINDOW_MS, last ? last.ts.getTime() + 1 : 0));
    calls = await repo.sessionCalls(ctx.tenantId, ctx.sessionKey, since, MAX_CALLS);
  } else {
    calls = [];
  }
  const who = sanitizeIdentity({ subject: ctx.principal.sub, clientId: ctx.principal.clientId ?? null, agentName: ctx.identity?.agentName ?? null });
  const saved = await repo.insertOutcome(ctx.tenantId, {
    source,
    sessionKey: ctx.sessionKey ?? null,
    subject: who.subject,
    clientId: who.clientId ?? null,
    agentName: who.agentName ?? null,
    virtualServerId: ctx.virtualServer?.id ?? calls.find((c) => c.virtualServerId)?.virtualServerId ?? null,
    outcome: input.outcome,
    reasonCode: input.reasonCode ?? null,
    callIds: calls.map((c) => c.callId),
    tools: [...new Set(calls.map((c) => c.toolName))],
  });
  return { outcomeId: saved.id, linkedCalls: calls.length, tools: saved.tools };
}

export type OutcomeHandler = (ctx: CallContext, args: unknown) => Promise<ToolResult>;

/** The meta-tool: recorded as a `meta` event; validation problems become tool errors. */
export function outcomeHandler(services: Services): OutcomeHandler {
  return (ctx, args) =>
    services.executor.metaCall(ctx, REPORT_OUTCOME, async () => {
      try {
        const r = await reportOutcome(services, ctx, parseOutcome(args), 'tool');
        return { content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r };
      } catch (err) {
        if (isGatewayError(err)) return err.toToolResult(ctx.principal.locale) as ToolResult;
        throw err;
      }
    });
}
