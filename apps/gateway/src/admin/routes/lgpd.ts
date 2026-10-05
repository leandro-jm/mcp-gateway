import { ValidationError } from '@mcp-gateway/core';
import type { SubjectRefRow } from '@mcp-gateway/db';
import { msg } from '@mcp-gateway/i18n/server';
import { subjectFingerprint } from '@mcp-gateway/redaction';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Services } from '../../services';
import { requirePrincipal, resolveTenantId, ROLE } from '../auth';
import { errorResponses, subjectAccessBody, subjectAccessResult } from '../schemas';

const toRow = (r: SubjectRefRow) => ({
  ts: r.ts.toISOString(),
  callId: r.callId,
  tool: r.toolName,
  subject: r.subject,
  clientId: r.clientId,
  agentName: r.agentName,
  decision: r.decision,
  direction: r.direction,
});

function countBy(rows: SubjectRefRow[], key: (r: SubjectRefRow) => string | null): Array<{ value: string | null; calls: number }> {
  const calls = new Map<string | null, Set<string>>();
  for (const r of rows) {
    const k = key(r);
    if (!calls.has(k)) calls.set(k, new Set());
    calls.get(k)!.add(r.callId);
  }
  return [...calls].map(([value, ids]) => ({ value, calls: ids.size })).sort((a, b) => b.calls - a.calls);
}

/**
 * "Which agents and users accessed data of subject X" (LGPD, ADR-017). The identifier is turned
 * into the tenant fingerprint and never stored, logged or audited; only gateway-admin may ask.
 */
export const lgpdRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  app.post('/lgpd/subject-access', {
    config: { roles: [ROLE.admin] },
    schema: {
      tags: ['lgpd'],
      summary: 'Calls that touched data of a data subject (by fingerprint; the value is never stored)',
      body: subjectAccessBody,
      response: { 200: subjectAccessResult, ...errorResponses },
    },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const caller = requirePrincipal(req);
      const { detector, value } = req.body;
      const fp = subjectFingerprint(await services.pii.subjectKey(tenantId), detector, value);
      if (!fp) throw new ValidationError(msg('analytics.lgpdInvalidIdentifier', { detector }));
      const to = req.body.to ? new Date(req.body.to) : new Date();
      const from = req.body.from
        ? new Date(req.body.from)
        : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - services.config.SUBJECT_INDEX_RETENTION_MONTHS, 1));
      const [matches, possible] = await Promise.all([
        services.repos.subjectRefs.lookup(tenantId, fp, from, to),
        services.repos.subjectRefs.truncatedCalls(tenantId, from, to),
      ]);
      const fingerprint = fp.toString('hex');
      await services.repos.audit.record(tenantId, {
        action: 'lgpd.subject_access',
        subject: caller.sub,
        clientId: caller.clientId ?? null,
        decision: 'allow',
        details: { detector, fingerprint, matches: new Set(matches.map((m) => m.callId)).size },
      });
      return {
        detector,
        fingerprint,
        from: from.toISOString(),
        to: to.toISOString(),
        total: new Set(matches.map((m) => m.callId)).size,
        matches: matches.map(toRow),
        summary: {
          subjects: countBy(matches, (r) => r.subject),
          agents: countBy(matches, (r) => r.agentName),
          clients: countBy(matches, (r) => r.clientId),
          tools: countBy(matches, (r) => r.toolName),
        },
        possibleMatches: possible.map(toRow),
      };
    },
  });
};
