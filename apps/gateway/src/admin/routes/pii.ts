import { randomBytes } from 'node:crypto';
import { readPiiSettings, ValidationError } from '@mcp-gateway/core';
import type { PiiRuleRow } from '@mcp-gateway/db';
import { FIELD_DETECTORS, isValidSelector, redact, VALUE_DETECTORS, withSynonyms, type PiiRule } from '@mcp-gateway/redaction';
import { msg } from '@mcp-gateway/i18n/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requestLocale } from '../../i18n';
import type { Services } from '../../services';
import { resolveTenantId, ROLE } from '../auth';
import {
  errorResponses,
  jsonObject,
  noContent,
  piiPreviewSchema,
  piiRuleCreateSchema,
  piiRulePatchSchema,
  piiRuleSchema,
  uuidParam,
} from '../schemas';

const KNOWN = new Set([...FIELD_DETECTORS.map((d) => d.id), ...VALUE_DETECTORS.map((d) => d.id), 'conta', 'field']);

const dto = (r: PiiRuleRow) => ({
  id: r.id,
  scope: r.scope,
  scopeRef: r.scopeRef,
  detector: r.detector,
  fieldSelector: r.fieldSelector,
  strategy: r.strategy,
  direction: r.direction,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

function validateRule(r: { scope?: string; scopeRef?: string | null; detector?: string; fieldSelector?: string | null }, extraDetectors: string[]) {
  if (r.detector && !KNOWN.has(r.detector) && !extraDetectors.includes(r.detector)) {
    throw new ValidationError(msg('admin.unknownDetector', { detector: r.detector }), { known: [...KNOWN].sort() });
  }
  if (r.detector === 'field' && !r.fieldSelector) throw new ValidationError(msg('admin.fieldDetectorRequiresSelector'));
  if (r.fieldSelector && !isValidSelector(r.fieldSelector)) throw new ValidationError(msg('admin.invalidFieldSelector', { selector: r.fieldSelector }));
  if ((r.scope === 'source' || r.scope === 'tool') && !r.scopeRef) throw new ValidationError(msg('admin.scopeRequiresRef', { scope: r.scope }));
}

export const piiRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const repo = services.repos.piiRules;
  const config = { roles: [ROLE.admin] };
  const tags = ['pii'];
  const extraDetectors = async (tenantId: string) =>
    Object.keys(readPiiSettings((await services.repos.tenants.get(tenantId)).settings).synonyms);

  app.get('/pii-rules', {
    config: { roles: [ROLE.admin, ROLE.owner] },
    schema: { tags, response: { 200: z.object({ items: z.array(piiRuleSchema) }), ...errorResponses } },
    handler: async (req) => ({ items: (await repo.list(await resolveTenantId(services, req))).map(dto) }),
  });

  app.post('/pii-rules', {
    config,
    schema: { tags, body: piiRuleCreateSchema, response: { 201: piiRuleSchema, ...errorResponses } },
    handler: async (req, reply) => {
      const tenantId = await resolveTenantId(services, req);
      validateRule(req.body, await extraDetectors(tenantId));
      return reply.code(201).send(dto(await repo.create(tenantId, req.body)));
    },
  });

  app.patch('/pii-rules/:id', {
    config,
    schema: { tags, params: uuidParam, body: piiRulePatchSchema, response: { 200: piiRuleSchema, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      validateRule(req.body, await extraDetectors(tenantId));
      return dto(await repo.update(tenantId, req.params.id, req.body));
    },
  });

  app.delete('/pii-rules/:id', {
    config,
    schema: { tags, params: uuidParam, response: { ...noContent, ...errorResponses } },
    handler: async (req, reply) => {
      await repo.delete(await resolveTenantId(services, req), req.params.id);
      return reply.code(204).send(null);
    },
  });

  app.post('/pii-rules/preview', {
    config: { roles: [ROLE.admin, ROLE.owner] },
    schema: {
      tags,
      summary: 'Applies the rules (saved or draft) to a sample payload',
      body: piiPreviewSchema,
      response: {
        200: z.object({ redacted: z.unknown(), count: z.number(), byDetector: z.record(z.string(), z.number()), tokens: z.number() }),
        ...errorResponses,
      },
    },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const tenant = await services.repos.tenants.get(tenantId);
      const tool = req.body.toolId ? await services.repos.tools.get(tenantId, req.body.toolId) : undefined;
      const rules: PiiRule[] = req.body.rules
        ? req.body.rules.map((r) => {
            validateRule(r, []);
            return { ...r, scopeRef: r.scopeRef ?? null };
          })
        : (await repo.list(tenantId)).map((r) => ({ ...r }));
      const res = redact(req.body.payload, {
        direction: req.body.direction,
        rules,
        ...(tool ? { toolId: tool.id, ...(tool.sourceId ? { sourceId: tool.sourceId } : {}) } : {}),
        // A throwaway key: with the tenant's key, hashes and tokens computed here for chosen
        // inputs would let a caller reverse low-entropy PII (CPF, phone) seen by agents.
        key: randomBytes(32),
        fieldDetectors: withSynonyms(readPiiSettings(tenant.settings).synonyms),
        locale: requestLocale(req),
      });
      return { redacted: res.value, count: res.count, byDetector: res.byDetector, tokens: res.tokens.length };
    },
  });

  app.get('/pii-detectors', {
    config: { roles: [ROLE.admin, ROLE.owner] },
    schema: { tags, response: { 200: z.object({ items: z.array(jsonObject) }), ...errorResponses } },
    handler: async () => ({
      items: [
        ...FIELD_DETECTORS.map((d) => ({ id: d.id, category: d.category, kind: 'field', synonyms: d.synonyms })),
        ...VALUE_DETECTORS.map((d) => ({ id: d.id, category: d.category, kind: 'value' })),
      ],
    }),
  });
};
