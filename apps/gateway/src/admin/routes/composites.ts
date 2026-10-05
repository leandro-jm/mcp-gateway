import { randomUUID } from 'node:crypto';
import {
  CompositeError,
  CompositeParseError,
  executeComposite,
  parseComposite,
  compositeGraph,
  type CompositeDefinition,
  type StepError,
} from '@mcp-gateway/composition';
import { applyOverrides, Forbidden, NotFound, readTrafficSettings, UpstreamError, ValidationError } from '@mcp-gateway/core';
import type { CompositeDef } from '@mcp-gateway/db';
import type { Locale } from '@mcp-gateway/i18n';
import { msg, translate } from '@mcp-gateway/i18n/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authorize } from '../../auth/authorizer';
import type { Principal } from '../../auth/tokens';
import type { CallContext } from '../../proxy/executor';
import { requestLocale } from '../../i18n';
import type { Services } from '../../services';
import { isAdmin, requirePrincipal, resolveTenantId, ROLE } from '../auth';
import { compositeChecker } from '../composite-check';
import { createComposite, parseCompositeSource } from '../composite-create';
import { renderIssues } from '../dto';
import { compositeSchema, compositeValidationSchema, compositeWriteSchema, dryRunSchema, errorResponses, uuidParam } from '../schemas';
import { canManageTool } from './tools';


/** Step error of a dry-run in `locale` (`msg` when present; `message` is the English fallback). */
function stepError(e: StepError, locale: Locale): { message: string; code?: string } {
  return { message: e.msg ? translate(e.msg, locale) : e.message, ...(e.code ? { code: e.code } : {}) };
}

export const compositeRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const { tools, composites } = services.repos;
  const config = { roles: [ROLE.admin, ROLE.owner] };
  const tags = ['composites'];

  const { check } = compositeChecker(services);

  async function dto(tenantId: string, c: CompositeDef, locale: Locale) {
    const tool = c.toolId ? await tools.get(tenantId, c.toolId) : undefined;
    return {
      id: c.id,
      toolId: c.toolId,
      name: tool ? applyOverrides(tool).name : '',
      state: tool?.state ?? null,
      status: c.status,
      version: c.version,
      source: c.source,
      definition: {
        input: c.inputSchema,
        steps: c.steps,
        ...(c.outputMapping ? { output: c.outputMapping } : {}),
        failure_mode: c.failureMode,
        timeout_ms: c.timeoutMs,
      },
      validationErrors: renderIssues(c.validationErrors, locale),
      dependsOnTools: c.dependsOnTools,
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  app.post('/composites/validate', {
    config,
    schema: { tags, summary: 'Validates a definition without saving it (Composer)', body: compositeWriteSchema, response: { 200: compositeValidationSchema, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const locale = requestLocale(req);
      let def: CompositeDefinition;
      try {
        def = parseComposite(req.body.source);
      } catch (err) {
        if (err instanceof CompositeParseError) {
          return { valid: false, errors: renderIssues(err.issues, locale), warnings: [], levels: [], dependsOn: [], annotations: {} };
        }
        throw err;
      }
      const { v, names } = await check(tenantId, def);
      return {
        ...v,
        errors: renderIssues(v.errors, locale),
        warnings: renderIssues(v.warnings, locale),
        dependsOn: names,
        annotations: v.annotations as Record<string, unknown>,
        graph: compositeGraph(def),
      };
    },
  });

  app.get('/composites', {
    config,
    schema: { tags, response: { 200: z.object({ items: z.array(compositeSchema) }), ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      return { items: await Promise.all((await composites.list(tenantId)).map((c) => dto(tenantId, c, requestLocale(req)))) };
    },
  });

  app.get('/composites/:id', {
    config,
    schema: { tags, params: uuidParam, response: { 200: compositeSchema, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      return dto(tenantId, await composites.get(tenantId, req.params.id), requestLocale(req));
    },
  });

  app.post('/composites', {
    config,
    schema: { tags, summary: 'Creates a composite tool (starts disabled)', body: compositeWriteSchema, response: { 201: compositeSchema, ...errorResponses } },
    handler: async (req, reply) => {
      const tenantId = await resolveTenantId(services, req);
      const comp = await createComposite(services, tenantId, requirePrincipal(req), req.body.source, {
        locale: requestLocale(req),
        ...(req.body.ownerTeam !== undefined ? { ownerTeam: req.body.ownerTeam } : {}),
      });
      req.affectedTenantId = tenantId;
      return reply.code(201).send(await dto(tenantId, comp, requestLocale(req)));
    },
  });

  app.put('/composites/:id', {
    config,
    schema: { tags, summary: 'New version of the definition', params: uuidParam, body: compositeWriteSchema, response: { 200: compositeSchema, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const principal = requirePrincipal(req);
      const current = await composites.get(tenantId, req.params.id);
      const tool = current.toolId ? await tools.get(tenantId, current.toolId) : undefined;
      // a composite without its tool has no team to check: only gateway-admin may change it
      if (tool ? !canManageTool(principal, tool) : !isAdmin(principal)) throw new Forbidden(msg('admin.compositeNoPermission'));
      const { def, text } = parseCompositeSource(req.body.source, requestLocale(req));
      const { v } = await check(tenantId, def);
      const version = current.version + 1;
      const updated = await composites.update(tenantId, current.id, {
        version,
        inputSchema: def.input,
        steps: def.steps,
        outputMapping: def.output ?? null,
        failureMode: def.failure_mode,
        timeoutMs: def.timeout_ms,
        dependsOnTools: v.dependsOn,
        status: v.valid ? 'valid' : 'invalid',
        validationErrors: v.errors,
        source: text,
      });
      if (tool) {
        await tools.update(
          tenantId,
          tool.id,
          {
            description: def.description,
            title: def.title ?? null,
            inputSchema: def.input,
            annotations: v.annotations,
            version,
            ...(v.valid ? {} : { state: tool.state === 'removed' ? 'removed' : 'disabled' }),
          },
          { diff: { summary: 'composite definition updated', by: principal.sub } },
        );
      }
      return dto(tenantId, updated, requestLocale(req));
    },
  });

  app.post('/composites/:id/dry-run', {
    config,
    schema: {
      tags,
      summary: 'Runs the composite as a simulated subject and shows every step',
      params: uuidParam,
      body: dryRunSchema,
      response: {
        200: z.object({
          output: z.unknown(),
          steps: z.record(z.string(), z.object({ status: z.string(), value: z.unknown(), error: z.unknown().optional(), durationMs: z.number(), calls: z.number() })),
          errors: z.record(z.string(), z.unknown()),
          rawVisible: z.boolean(),
          durationMs: z.number(),
        }),
        ...errorResponses,
      },
    },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const caller = requirePrincipal(req);
      const locale = requestLocale(req);
      const comp = await composites.get(tenantId, req.params.id);
      if (!comp.toolId) throw new NotFound('composite', comp.id);
      const snapshot = await services.registry.get(tenantId);
      const compTool = snapshot.tools.find((t) => t.id === comp.toolId);
      if (!compTool) throw new NotFound('tool', comp.toolId);
      const def = parseComposite({
        name: compTool.baseName,
        description: compTool.description,
        input: comp.inputSchema,
        steps: comp.steps,
        ...(comp.outputMapping ? { output: comp.outputMapping } : {}),
        failure_mode: comp.failureMode,
        timeout_ms: comp.timeoutMs,
      });
      // Steps reach the upstreams for real: owners only dry-run their own composites, never as
      // gateway-admin nor with writes, and the audit keeps their identity.
      const admin = isAdmin(caller);
      if (!admin) {
        if (!canManageTool(caller, compTool)) throw new Forbidden(msg('admin.compositeNoPermission'));
        if (req.body.subject?.roles.includes(ROLE.admin)) throw new Forbidden(msg('admin.playgroundAdminSubject'));
        if (req.body.allowWrites) throw new Forbidden(msg('admin.dryRunWritesAdminOnly'));
      }
      const subject: Principal = req.body.subject
        ? {
            sub: admin ? req.body.subject.sub : caller.sub,
            tenant: snapshot.tenant.slug,
            roles: req.body.subject.roles,
            groups: req.body.subject.groups,
            clientId: admin ? req.body.subject.clientId : 'playground',
            claims: req.body.subject.claims as never,
            locale: caller.locale,
          }
        : caller;
      if (compTool.annotations.readOnlyHint !== true && !req.body.allowWrites) {
        throw new ValidationError(msg('admin.dryRunRequiresAllowWrites'));
      }
      const byName = new Map(snapshot.tools.map((t) => [t.name, t]));
      const ctx: CallContext = { tenantId, principal: subject, snapshot, requestId: randomUUID() };
      const executor = services.executor;
      const traffic = readTrafficSettings(snapshot.tenant.settings);
      const rawVisible = admin;
      try {
        const r = await executeComposite(def, req.body.input, {
          locale,
          callStep: async (call) => {
            const st = byName.get(call.tool);
            if (!st || st.state !== 'enabled') throw new ValidationError(msg('admin.stepToolUnavailable', { tool: call.tool }));
            if (authorize(snapshot, subject, st, 'list').effect !== 'allow') throw new Forbidden(msg('admin.stepAccessDenied', { step: call.stepId, tool: call.tool }));
            executor.validate(st, call.args);
            await executor.authorizeCall(ctx, st, call.args, undefined, call.stepId);
            const res = await executor.invokeUpstream(ctx, st, call.args, traffic);
            if (res.status >= 400) throw new UpstreamError(msg('admin.stepUpstreamStatus', { tool: call.tool, status: res.status }), res.status);
            return res.body;
          },
        });
        const redact = async (v: unknown) => (rawVisible ? v : (await services.pii.redactResponse({ tenantId, snapshot, subject: subject.sub }, compTool, v)).value);
        const steps: Record<string, { status: string; value: unknown; error?: unknown; durationMs: number; calls: number }> = {};
        for (const [id, s] of Object.entries(r.steps)) {
          steps[id] = { status: s.status, value: await redact(s.value), ...(s.error ? { error: stepError(s.error, locale) } : {}), durationMs: s.durationMs, calls: s.calls };
        }
        const output = (await services.pii.redactResponse({ tenantId, snapshot, subject: subject.sub }, compTool, r.output)).value;
        const errors = Object.fromEntries(Object.entries(r.errors).map(([id, e]) => [id, stepError(e, locale)]));
        return { output, steps, errors, rawVisible, durationMs: r.durationMs };
      } catch (err) {
        if (err instanceof CompositeError) {
          if (err.cause instanceof Forbidden) throw err.cause;
          throw new ValidationError(err.msg, { step: err.stepId, code: err.code });
        }
        throw err;
      }
    },
  });
};
