import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Services } from '../../services';
import { resolveTenantId, ROLE } from '../auth';
import { auditEventSchema, auditQuery, errorResponses, page } from '../schemas';

export const auditRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  app.get('/audit', {
    config: { roles: [ROLE.admin] },
    schema: {
      tags: ['audit'],
      summary: 'Audit events (no clear-text PII)',
      querystring: auditQuery,
      response: { 200: page(auditEventSchema), ...errorResponses },
    },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const { from, to, ...rest } = req.query;
      const filter = { ...rest, ...(from ? { from: new Date(from) } : {}), ...(to ? { to: new Date(to) } : {}) };
      const [items, total] = await Promise.all([services.repos.audit.list(tenantId, filter), services.repos.audit.count(tenantId, filter)]);
      return {
        total,
        items: items.map((e) => ({
          id: e.id,
          ts: e.ts.toISOString(),
          action: e.action,
          subject: e.subject,
          clientId: e.clientId,
          toolId: e.toolId,
          toolName: e.toolName,
          decision: e.decision,
          statusCode: e.statusCode,
          latencyMs: e.latencyMs,
          redactionsCount: e.redactionsCount,
          projectedBytesSaved: e.projectedBytesSaved,
          artifactId: e.artifactId,
          traceId: e.traceId,
          callId: e.callId,
          parentCallId: e.parentCallId,
          details: e.details ?? null,
        })),
      };
    },
  });
};
