import { applyOverrides, isSafeRegex, MAX_PATTERN_LENGTH, NotFound, ValidationError } from '@mcp-gateway/core';
import { msg, raw, translate } from '@mcp-gateway/i18n/server';
import { ConditionSyntaxError, conditionsSchema, evaluate, parseConstraint, type PolicyRule } from '@mcp-gateway/policy';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requestLocale } from '../../i18n';
import type { Services } from '../../services';
import { resolveTenantId, ROLE } from '../auth';
import { policyDto } from '../dto';
import {
  decisionSchema,
  errorResponses,
  noContent,
  policyCreateSchema,
  policyPatchSchema,
  policySchema,
  simulateSchema,
  uuidParam,
} from '../schemas';

/** Validates conditions on write (fails early instead of the rule being ignored at runtime). */
function validateConditions(conditions: unknown): Record<string, unknown> {
  const parsed = conditionsSchema.safeParse(conditions ?? {});
  if (!parsed.success) {
    throw new ValidationError(
      msg('admin.invalidConditions'),
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  for (const c of parsed.data.args ?? []) {
    let op: string;
    let pattern: unknown;
    if (typeof c === 'string') {
      let p: ReturnType<typeof parseConstraint>;
      try {
        p = parseConstraint(c);
      } catch (err) {
        throw new ValidationError(err instanceof ConditionSyntaxError ? err.msg : raw((err as Error).message));
      }
      op = p.op;
      // a pattern taken from the arguments would let the agent choose the regex
      pattern = p.rhs?.kind === 'args' ? undefined : p.rhs?.kind === 'literal' ? p.rhs.value : '';
    } else {
      op = c.op;
      pattern = c.claim !== undefined ? '' : c.value;
    }
    if (op === 'regex' && (typeof pattern !== 'string' || (pattern !== '' && !isSafeRegex(pattern)))) {
      throw new ValidationError(msg('config.unsafeRegex', { pattern: String(pattern ?? c), max: MAX_PATTERN_LENGTH }));
    }
  }
  for (const w of parsed.data.timeWindows ?? []) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: w.tz });
    } catch {
      throw new ValidationError(msg('admin.invalidTimeZone', { tz: w.tz }));
    }
  }
  return (conditions ?? {}) as Record<string, unknown>;
}

export const policyRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const { policies, tools } = services.repos;
  const config = { roles: [ROLE.admin] };
  const tags = ['policies'];

  app.get('/policies', {
    config: { roles: [ROLE.admin, ROLE.owner] },
    schema: { tags, response: { 200: z.object({ items: z.array(policySchema) }), ...errorResponses } },
    handler: async (req) => ({ items: (await policies.list(await resolveTenantId(services, req))).map(policyDto) }),
  });

  app.post('/policies', {
    config,
    schema: { tags, body: policyCreateSchema, response: { 201: policySchema, ...errorResponses } },
    handler: async (req, reply) => {
      const tenantId = await resolveTenantId(services, req);
      const created = await policies.create(tenantId, { ...req.body, conditions: validateConditions(req.body.conditions) });
      return reply.code(201).send(policyDto(created));
    },
  });

  app.get('/policies/:id', {
    config: { roles: [ROLE.admin, ROLE.owner] },
    schema: { tags, params: uuidParam, response: { 200: policySchema, ...errorResponses } },
    handler: async (req) => policyDto(await policies.get(await resolveTenantId(services, req), req.params.id)),
  });

  app.patch('/policies/:id', {
    config,
    schema: { tags, params: uuidParam, body: policyPatchSchema, response: { 200: policySchema, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const patch = { ...req.body };
      if (patch.conditions !== undefined) patch.conditions = validateConditions(patch.conditions);
      return policyDto(await policies.update(tenantId, req.params.id, patch));
    },
  });

  app.delete('/policies/:id', {
    config,
    schema: { tags, params: uuidParam, response: { ...noContent, ...errorResponses } },
    handler: async (req, reply) => {
      await policies.delete(await resolveTenantId(services, req), req.params.id);
      return reply.code(204).send(null);
    },
  });

  app.post('/policies/simulate', {
    config: { roles: [ROLE.admin, ROLE.owner] },
    schema: {
      tags,
      summary: 'Simulates the authorization decision for (subject, tool, args)',
      body: simulateSchema,
      response: { 200: decisionSchema, ...errorResponses },
    },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const tool = await tools.findByName(tenantId, req.body.tool);
      if (!tool) throw new NotFound('tool', req.body.tool);
      const all = await policies.list(tenantId);
      const rules: PolicyRule[] = all.map((p) => ({ ...p, description: p.description }));
      const d = evaluate(rules, {
        subject: req.body.subject,
        tool: { name: applyOverrides(tool).name, annotations: tool.annotations },
        mode: req.body.mode,
        ...(req.body.args ? { args: req.body.args } : {}),
        ...(req.body.at ? { now: new Date(req.body.at) } : {}),
      });
      const locale = requestLocale(req);
      const rule = d.ruleId ? all.find((p) => p.id === d.ruleId) : undefined;
      return {
        effect: d.effect,
        reason: d.reason,
        ruleId: d.ruleId ?? null,
        explanation: translate(d.explanation, locale),
        rule: rule ? policyDto(rule) : null,
        obligations: d.obligations,
        trace: d.trace.map((t) => ({ ...t, note: translate(t.note, locale) })),
        tool: { id: tool.id, name: applyOverrides(tool).name, state: tool.state, annotations: tool.annotations as Record<string, unknown> },
      };
    },
  });
};
