import { Forbidden, NotFound, ValidationError } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { callDto, explainCall } from '../../analytics/explain';
import type { Principal } from '../../auth/tokens';
import type { Services } from '../../services';
import { isAdmin, requirePrincipal, resolveTenantId, ROLE } from '../auth';
import { callIdParam, callsQuery, errorResponses, jsonObject } from '../schemas';
import { ANALYTICS_ROLES } from './analytics';
import { canManageTool } from './tools';

const encodeCursor = (ts: Date, callId: string) => Buffer.from(`${ts.toISOString()}|${callId}`).toString('base64url');

function decodeCursor(cursor: string): { ts: Date; callId: string } {
  const [iso, callId] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const ts = new Date(iso ?? '');
  if (!callId || Number.isNaN(ts.getTime())) throw new ValidationError(msg('analytics.invalidQuery', { reason: 'cursor' }));
  return { ts, callId };
}

/** Tool owners only see calls of the tools they manage; analytics roles see everything. */
async function ownedTools(services: Services, tenantId: string, caller: Principal): Promise<string[] | undefined> {
  if (isAdmin(caller) || caller.roles.includes(ROLE.analyticsReader)) return undefined;
  return (await services.registry.get(tenantId)).tools.filter((t) => canManageTool(caller, t)).map((t) => t.name);
}

/** Call explorer (F15.13): list of calls and the explanation of one call. Never payloads. */
export const callRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const tags = ['calls'];
  const readers = { roles: [...ANALYTICS_ROLES, ROLE.owner] };

  app.get('/calls', {
    config: readers,
    schema: { tags, summary: 'Calls, newest first (keyset pagination by cursor)', querystring: callsQuery, response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const q = req.query;
      const toolNames = await ownedTools(services, tenantId, requirePrincipal(req));
      const rows = await services.repos.callEvents.list(tenantId, {
        ...(q.tool ? { toolName: q.tool } : {}),
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.decision ? { decision: q.decision } : {}),
        ...(q.errorCode ? { errorCode: q.errorCode } : {}),
        ...(q.client ? { clientId: q.client } : {}),
        ...(q.agent ? { agentName: q.agent } : {}),
        ...(q.session ? { sessionKey: q.session } : {}),
        ...(q.trace ? { traceId: q.trace } : {}),
        ...(q.from ? { from: new Date(q.from) } : {}),
        ...(q.to ? { to: new Date(q.to) } : {}),
        ...(q.cursor ? { before: decodeCursor(q.cursor) } : {}),
        ...(toolNames ? { toolNames } : {}),
        limit: q.limit,
      });
      const last = rows.at(-1);
      return { items: rows.map(callDto), nextCursor: rows.length === q.limit && last ? encodeCursor(last.ts, last.callId) : null };
    },
  });

  app.get('/calls/:callId', {
    config: readers,
    schema: { tags, summary: 'Explains one call: stages, policy rule and trace, redactions, projection cut, steps', params: callIdParam, response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const explanation = await explainCall(services, tenantId, req.params.callId);
      if (!explanation) throw new NotFound('call', req.params.callId);
      const toolNames = await ownedTools(services, tenantId, requirePrincipal(req));
      if (toolNames && !toolNames.includes(explanation.call.tool.name)) throw new Forbidden(msg('analytics.callForbidden'));
      return explanation;
    },
  });
};
