import { LAST, SESSION_GAP_MS, type LastRange } from '@mcp-gateway/call-analytics';
import { skeletonFromSequence } from '@mcp-gateway/composer';
import { Conflict, NotFound, ValidationError } from '@mcp-gateway/core';
import type { CompositeSuggestion } from '@mcp-gateway/db';
import { msg, translate } from '@mcp-gateway/i18n/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { callDto } from '../../analytics/explain';
import { runAgentAnalytics } from '../../analytics/job';
import { rangeOf } from '../../analytics/views';
import { requestLocale } from '../../i18n';
import type { RegistrySnapshot } from '../../registry/snapshot';
import type { Services } from '../../services';
import { requirePrincipal, resolveTenantId, ROLE } from '../auth';
import { createComposite } from '../composite-create';
import { errorResponses, jsonObject, uuidParam, viewQuery } from '../schemas';
import { ANALYTICS_ROLES } from './analytics';

const sessionsQuery = viewQuery.extend({ agent: z.string().max(64).optional(), subject: z.string().max(200).optional() });
const sessionParam = z.object({ key: z.string().regex(/^[sp]-[0-9a-f]{32}$/) });
const findingsQuery = viewQuery.extend({ type: z.enum(['loop', 'thrash', 'search_miss', 'abandoned']).optional() });
const suggestionsQuery = z.object({ status: z.enum(['open', 'accepted', 'dismissed']).optional() });
const acceptBody = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(), ownerTeam: z.string().optional() }).default({});

/** Draft YAML of a suggestion (only when every tool still exists and is enabled). */
function draftOf(snapshot: RegistrySnapshot, s: CompositeSuggestion, locale: Parameters<typeof translate>[1], name?: string): string | undefined {
  const tools = s.sequence.map((n) => snapshot.tools.find((t) => t.name === n && t.state === 'enabled' && t.kind !== 'composite'));
  if (tools.some((t) => !t)) return undefined;
  return skeletonFromSequence(
    tools.map((t) => ({ name: t!.name, inputSchema: t!.inputSchema, outputSchema: t!.outputSchema })),
    {
      name: name ?? `suggested_${s.sequenceHash.slice(0, 8)}`,
      description: translate(msg('analytics.suggestionDescription', { sessions: s.sessions, sequence: s.sequence.join(' → ') }), locale),
    },
  );
}

const suggestionDto = (s: CompositeSuggestion, draft?: string) => ({
  id: s.id,
  sequence: s.sequence,
  sessions: s.sessions,
  subjects: s.subjects,
  share: s.share,
  status: s.status,
  compositeId: s.compositeId,
  firstSeen: s.firstSeen.toISOString(),
  lastSeen: s.lastSeen.toISOString(),
  draft: draft ?? null,
});

/**
 * Agent analytics API (F15.23): sessions and trajectories, findings, composite suggestions,
 * co-usage and reported outcomes.
 */
export const agentRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const tags = ['agents'];
  const readers = { roles: ANALYTICS_ROLES };
  const repo = services.repos.agentAnalytics;

  app.get('/sessions', {
    config: readers,
    schema: { tags, summary: 'Agent sessions of the period, newest activity first', querystring: sessionsQuery, response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const r = rangeOf(req.query.last);
      const items = await repo.sessions(tenantId, r.from, r.to, { ...(req.query.agent ? { agent: req.query.agent } : {}), ...(req.query.subject ? { subject: req.query.subject } : {}) });
      return { items: items.map((s) => ({ ...s, start: s.start.toISOString(), end: s.end.toISOString() })) };
    },
  });

  app.get('/sessions/:key', {
    config: readers,
    schema: { tags, summary: 'Trajectory of a session: calls in order, split by idle gaps, with findings', params: sessionParam, querystring: viewQuery, response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const last = req.query.last as LastRange;
      const to = new Date();
      const rows = await services.repos.callEvents.bySession(tenantId, req.params.key, new Date(to.getTime() - LAST[last]), to);
      if (!rows.length) throw new NotFound('call', req.params.key);
      const segments: Array<{ start: string; end: string; events: ReturnType<typeof callDto>[] }> = [];
      for (const r of rows) {
        const cur = segments[segments.length - 1];
        if (!cur || r.ts.getTime() - new Date(cur.end).getTime() > SESSION_GAP_MS) segments.push({ start: r.ts.toISOString(), end: r.ts.toISOString(), events: [] });
        const seg = segments[segments.length - 1]!;
        seg.events.push(callDto(r));
        seg.end = r.ts.toISOString();
      }
      const findings = await repo.findings(tenantId, { sessionKey: req.params.key });
      return { sessionKey: req.params.key, segments, findings: findings.map((f) => ({ ...f, at: f.at.toISOString(), createdAt: f.createdAt.toISOString() })) };
    },
  });

  app.get('/agent-insights/findings', {
    config: readers,
    schema: { tags, summary: 'Bad patterns found in sessions (loops, thrash, search misses, abandonment)', querystring: findingsQuery, response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const items = await repo.findings(tenantId, { from: rangeOf(req.query.last).from, ...(req.query.type ? { type: req.query.type } : {}) });
      return { items: items.map((f) => ({ ...f, at: f.at.toISOString(), createdAt: f.createdAt.toISOString() })) };
    },
  });

  app.get('/agent-insights/suggestions', {
    config: { roles: [...ANALYTICS_ROLES, ROLE.owner] },
    schema: { tags, summary: 'Frequent call sequences proposed as composite drafts', querystring: suggestionsQuery, response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const snapshot = await services.registry.get(tenantId);
      const items = await repo.suggestions(tenantId, req.query.status);
      return { items: items.map((s) => suggestionDto(s, s.status === 'open' ? draftOf(snapshot, s, requestLocale(req)) : undefined)) };
    },
  });

  app.post('/agent-insights/suggestions/:id/accept', {
    config: { roles: [ROLE.admin, ROLE.owner] },
    schema: { tags, summary: 'Creates the suggested composite as a disabled draft', params: uuidParam, body: acceptBody, response: { 201: jsonObject, ...errorResponses } },
    handler: async (req, reply) => {
      const tenantId = await resolveTenantId(services, req);
      const s = await repo.suggestion(tenantId, req.params.id);
      if (!s) throw new NotFound('suggestion', req.params.id);
      if (s.status !== 'open') throw new Conflict(msg('analytics.suggestionClosed', { status: s.status }));
      const snapshot = await services.registry.get(tenantId);
      const draft = draftOf(snapshot, s, requestLocale(req), req.body.name);
      if (!draft) throw new ValidationError(msg('analytics.suggestionUnavailable'));
      const comp = await createComposite(services, tenantId, requirePrincipal(req), draft, {
        locale: requestLocale(req),
        draft: true,
        ...(req.body.ownerTeam !== undefined ? { ownerTeam: req.body.ownerTeam } : {}),
      });
      const updated = await repo.setSuggestionStatus(tenantId, s.id, 'accepted', comp.id);
      req.affectedTenantId = tenantId;
      return reply.code(201).send({ suggestion: suggestionDto(updated!), compositeId: comp.id, toolId: comp.toolId, source: comp.source });
    },
  });

  app.post('/agent-insights/suggestions/:id/dismiss', {
    config: { roles: [ROLE.admin, ROLE.owner] },
    schema: { tags, summary: 'Dismisses a suggestion (it will not come back)', params: uuidParam, response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const s = await repo.setSuggestionStatus(tenantId, req.params.id, 'dismissed');
      if (!s) throw new NotFound('suggestion', req.params.id);
      return suggestionDto(s);
    },
  });

  app.post('/agent-insights/refresh', {
    config: { roles: [ROLE.admin] },
    schema: { tags, summary: 'Runs the agent analytics job now for the tenant (it also runs every 15 minutes)', response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      return { ...(await runAgentAnalytics(services, new Date(), { tenantIds: [tenantId] })) };
    },
  });

  app.get('/analytics/co-usage', {
    config: readers,
    schema: { tags, summary: 'Which tools are used together (consecutive successful calls)', querystring: viewQuery, response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const r = rangeOf(req.query.last);
      const edges = await repo.coUsage(tenantId, r.from.toISOString().slice(0, 10), r.to.toISOString().slice(0, 10));
      return { nodes: [...new Set(edges.flatMap((e) => [e.from, e.to]))], edges };
    },
  });

  app.get('/analytics/outcomes', {
    config: readers,
    schema: { tags, summary: 'Reported task outcomes: real success rate per tool and virtual server', querystring: viewQuery, response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const r = rangeOf(req.query.last);
      const q = (groupBy: Array<'tool' | 'virtual_server'>) => services.analytics.query(tenantId, { metric: 'success_rate', groupBy, filters: {}, from: r.from, to: r.to, limit: 100, order: 'asc' });
      const [byTool, byServer, recent] = await Promise.all([q(['tool']), q(['virtual_server']), repo.outcomes(tenantId, r.from, r.to, 200)]);
      const totals: Record<string, number> = {};
      for (const o of recent) totals[o.outcome] = (totals[o.outcome] ?? 0) + 1;
      const snapshot = await services.registry.get(tenantId);
      return {
        totals,
        byTool: byTool.rows.map((x) => ({ tool: x.keys.tool, successRate: x.value })),
        byVirtualServer: byServer.rows.map((x) => ({ virtualServer: snapshot.virtualServers.find((v) => v.id === x.keys.virtual_server)?.slug ?? x.keys.virtual_server, successRate: x.value })),
        recent: recent.slice(0, 50).map((o) => ({ ts: o.ts.toISOString(), outcome: o.outcome, reasonCode: o.reasonCode, agentName: o.agentName, tools: o.tools, source: o.source })),
      };
    },
  });
};
