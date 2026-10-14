import { NotFound, ValidationError } from '@mcp-gateway/core';
import type { JsonObject, TenantTheme, ToolView } from '@mcp-gateway/db';
import { msg } from '@mcp-gateway/i18n/server';
import { infer, parseToolViews, TILE_URL, validateSpec, validateTheme, type ThemeTokens, type ToolLike } from '@mcp-ui-kit/view-spec';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Services } from '../../services';
import { requirePrincipal, resolveTenantId, ROLE } from '../auth';
import { errorResponses, noContent, uuidParam } from '../schemas';
import { canManageTool } from './tools';

const issueSchema = z.object({ code: z.string(), path: z.string() });
const viewSchema = z.object({
  toolId: z.uuid(),
  views: z.record(z.string(), z.unknown()),
  status: z.enum(['suggested', 'active', 'disabled']),
  specVersion: z.number().int(),
  /** Problems against the current tool contract (drift): an active view with issues is not served. */
  issues: z.array(issueSchema),
  updatedAt: z.string(),
});
const viewPutSchema = z.object({ views: z.record(z.string(), z.unknown()), status: z.enum(['suggested', 'active', 'disabled']).default('active') });
const themeSchema = z.object({
  tokens: z.record(z.string(), z.unknown()),
  tileUrl: z.string().nullable(),
  tileAttribution: z.string().nullable(),
  warnings: z.array(issueSchema),
  updatedAt: z.string().nullable(),
});
const themePutSchema = z.object({
  tokens: z.record(z.string(), z.unknown()),
  tileUrl: z.string().max(500).nullable().optional(),
  tileAttribution: z.string().max(300).nullable().optional(),
});

type ToolRow = Awaited<ReturnType<Services['repos']['tools']['get']>>;

/** The tool as `view-spec` sees it: the contract the views must match. */
const toolLike = (t: ToolRow): ToolLike => ({
  name: t.name,
  ...(t.title ? { title: t.title } : {}),
  inputSchema: t.inputSchema,
  ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
  annotations: t.annotations,
});

const issuesText = (issues: Array<{ code: string; path: string }>) => issues.map((i) => `${i.code}@${i.path}`).join(', ');

/** Parses and checks a spec against the tool; throws a 400 listing the issues. */
function checkedViews(raw: unknown, tool: ToolRow) {
  const parsed = parseToolViews(raw);
  if (!parsed.ok) throw new ValidationError(msg('ui.invalidViews', { issues: issuesText(parsed.issues) }), { issues: parsed.issues });
  const issues = validateSpec(parsed.value, toolLike(tool));
  if (issues.length) throw new ValidationError(msg('ui.invalidViews', { issues: issuesText(issues) }), { issues });
  return parsed.value;
}

function viewDto(v: ToolView, tool: ToolRow) {
  const parsed = parseToolViews(v.views);
  return {
    toolId: v.toolId,
    views: v.views,
    status: v.status,
    specVersion: v.specVersion,
    issues: parsed.ok ? validateSpec(parsed.value, toolLike(tool)) : parsed.issues,
    updatedAt: v.updatedAt.toISOString(),
  };
}

const themeDto = (t: TenantTheme | undefined) => ({
  tokens: t?.tokens ?? {},
  tileUrl: t?.tileUrl ?? null,
  tileAttribution: t?.tileAttribution ?? null,
  warnings: t ? validateTheme(t.tokens as ThemeTokens).warnings : [],
  updatedAt: t?.updatedAt.toISOString() ?? null,
});

/** Generative UI admin (ADR-022): views per tool and the tenant theme. */
export const viewRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const { toolViews, tenantThemes, tools, audit } = services.repos;
  const tags = ['views'];
  const ownerConfig = { roles: [ROLE.admin, ROLE.owner] };

  async function managed(req: Parameters<typeof resolveTenantId>[1], toolId: string) {
    const tenantId = await resolveTenantId(services, req);
    const tool = await tools.get(tenantId, toolId);
    const p = requirePrincipal(req);
    if (!canManageTool(p, tool)) throw new NotFound('tool', toolId);
    return { tenantId, tool, principal: p };
  }

  app.get('/tools/:id/view', {
    config: ownerConfig,
    schema: { tags, params: uuidParam, response: { 200: viewSchema, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const tool = await tools.get(tenantId, req.params.id);
      const v = await toolViews.get(tenantId, tool.id);
      if (!v) throw new NotFound('view', tool.id);
      return viewDto(v, tool);
    },
  });

  app.put('/tools/:id/view', {
    config: ownerConfig,
    schema: { tags, params: uuidParam, body: viewPutSchema, response: { 200: viewSchema, ...errorResponses } },
    handler: async (req) => {
      const { tenantId, tool, principal } = await managed(req, req.params.id);
      const views = checkedViews(req.body.views, tool);
      const saved = await toolViews.upsert(tenantId, tool.id, views as unknown as JsonObject, req.body.status, views.version);
      await audit.record(tenantId, {
        action: 'view.update',
        subject: principal.sub,
        clientId: principal.clientId,
        toolId: tool.id,
        toolName: tool.name,
        decision: 'applied',
        details: { status: saved.status, input: views.input?.kind ?? null, result: views.result?.kind ?? null },
      });
      return viewDto(saved, tool);
    },
  });

  app.post('/tools/:id/view/suggest', {
    config: ownerConfig,
    schema: {
      tags,
      summary: 'Infers views from the tool contract (not saved)',
      params: uuidParam,
      response: { 200: z.object({ views: z.record(z.string(), z.unknown()) }), ...errorResponses },
    },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const tool = await tools.get(tenantId, req.params.id);
      const views = infer(toolLike(tool));
      if (!views) throw new ValidationError(msg('ui.noSuggestion'));
      return { views: views as unknown as Record<string, unknown> };
    },
  });

  app.delete('/tools/:id/view', {
    config: ownerConfig,
    schema: { tags, params: uuidParam, response: { ...noContent, ...errorResponses } },
    handler: async (req, reply) => {
      const { tenantId, tool } = await managed(req, req.params.id);
      if (!(await toolViews.delete(tenantId, tool.id))) throw new NotFound('view', tool.id);
      return reply.code(204).send(null);
    },
  });

  app.get('/settings/theme', {
    config: ownerConfig,
    schema: { tags, response: { 200: themeSchema, ...errorResponses } },
    handler: async (req) => themeDto(await tenantThemes.get(await resolveTenantId(services, req))),
  });

  app.put('/settings/theme', {
    config: { roles: [ROLE.admin] },
    schema: { tags, body: themePutSchema, response: { 200: themeSchema, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const report = validateTheme(req.body.tokens as ThemeTokens);
      if (report.errors.length) throw new ValidationError(msg('ui.invalidTheme', { issues: issuesText(report.errors) }), { issues: report.errors });
      if (req.body.tileUrl && !TILE_URL.test(req.body.tileUrl)) throw new ValidationError(msg('ui.invalidTileUrl'));
      const saved = await tenantThemes.upsert(tenantId, {
        tokens: req.body.tokens as JsonObject,
        tileUrl: req.body.tileUrl ?? null,
        tileAttribution: req.body.tileAttribution ?? null,
      });
      const p = requirePrincipal(req);
      await audit.record(tenantId, { action: 'theme.update', subject: p.sub, clientId: p.clientId, decision: 'applied', details: {} });
      return themeDto(saved);
    },
  });

  app.delete('/settings/theme', {
    config: { roles: [ROLE.admin] },
    schema: { tags, response: { ...noContent, ...errorResponses } },
    handler: async (req, reply) => {
      const tenantId = await resolveTenantId(services, req);
      await tenantThemes.delete(tenantId);
      return reply.code(204).send(null);
    },
  });
};
