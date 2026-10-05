import { canTransition, Forbidden, targetState, ValidationError, type ToolAction, type ToolOverrides } from '@mcp-gateway/core';
import type { Tool } from '@mcp-gateway/db';
import { msg } from '@mcp-gateway/i18n/server';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Principal } from '../../auth/tokens';
import { requestLocale } from '../../i18n';
import type { Services } from '../../services';
import { isAdmin, requirePrincipal, resolveTenantId, ROLE } from '../auth';
import { renderIssues, toolDto, toolVersionDto } from '../dto';
import { errorResponses, page, toolPatchSchema, toolQuery, toolSchema, toolVersionSchema, uuidParam } from '../schemas';

/** gateway-admin, or a tool-owner of the tool's owner_team (`groups` claim). */
export function canManageTool(p: Principal, tool: Pick<Tool, 'ownerTeam'>): boolean {
  if (isAdmin(p)) return true;
  return p.roles.includes(ROLE.owner) && tool.ownerTeam !== null && p.groups.includes(tool.ownerTeam);
}

export const toolRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const { tools, audit } = services.repos;
  const readers = { roles: [ROLE.admin, ROLE.owner] };
  const tags = ['tools'];

  async function loadManaged(req: FastifyRequest, id: string) {
    const tenantId = await resolveTenantId(services, req);
    const tool = await tools.get(tenantId, id);
    const p = requirePrincipal(req);
    if (!canManageTool(p, tool)) {
      throw new Forbidden(msg('admin.toolManageForbidden', { team: tool.ownerTeam ?? msg('admin.noTeam') }));
    }
    return { tenantId, tool, principal: p };
  }

  app.get('/tools', {
    config: readers,
    schema: { tags, querystring: toolQuery, response: { 200: page(toolSchema), ...errorResponses } },
    handler: async (req) => {
      const r = await tools.list(await resolveTenantId(services, req), req.query);
      return { items: r.items.map(toolDto), total: r.total };
    },
  });

  app.get('/tools/:id', {
    config: readers,
    schema: { tags, params: uuidParam, response: { 200: toolSchema, ...errorResponses } },
    handler: async (req) => toolDto(await tools.get(await resolveTenantId(services, req), req.params.id)),
  });

  app.get('/tools/:id/versions', {
    config: readers,
    schema: {
      tags,
      params: uuidParam,
      response: { 200: z.object({ items: z.array(toolVersionSchema) }), ...errorResponses },
    },
    handler: async (req) => ({
      items: (await tools.versions(await resolveTenantId(services, req), req.params.id)).map(toolVersionDto),
    }),
  });

  app.patch('/tools/:id', {
    config: readers,
    schema: {
      tags,
      summary: 'Sets overrides (they survive re-crawls)',
      params: uuidParam,
      body: toolPatchSchema,
      response: { 200: toolSchema, ...errorResponses },
    },
    handler: async (req) => {
      const { tenantId, tool, principal } = await loadManaged(req, req.params.id);
      const current = tool.overrides as ToolOverrides;
      // Policies match the effective name: renaming would let an owner aim at another rule's pattern.
      if (req.body.name !== undefined && (req.body.name ?? undefined) !== current.name && !isAdmin(principal)) {
        throw new Forbidden(msg('admin.renameAdminOnly'));
      }
      const next: Record<string, unknown> = { ...current };
      for (const [k, v] of Object.entries(req.body)) {
        if (v === undefined) continue;
        if (v === null) delete next[k];
        else next[k] = v;
      }
      if (next.inputSchema !== undefined && typeof next.inputSchema !== 'object') {
        throw new ValidationError(msg('admin.inputSchemaMustBeObject'));
      }
      const updated = await tools.setOverrides(tenantId, tool.id, next as ToolOverrides);
      await audit.record(tenantId, {
        action: 'tool.override',
        subject: principal.sub,
        clientId: principal.clientId,
        toolId: tool.id,
        toolName: toolDto(updated).name,
        decision: 'applied',
        details: { fields: Object.keys(req.body) },
      });
      return toolDto(updated);
    },
  });

  for (const action of ['enable', 'disable', 'deprecate'] as const satisfies readonly ToolAction[]) {
    app.post(`/tools/:id/${action}`, {
      config: readers,
      schema: { tags, params: uuidParam, response: { 200: toolSchema, ...errorResponses } },
      handler: async (req) => {
        const { tenantId, tool, principal } = await loadManaged(req, req.params.id);
        const to = targetState(action);
        if (tool.kind === 'composite' && to === 'enabled') {
          const def = await services.repos.composites.getByTool(tenantId, tool.id);
          if (def?.status !== 'valid') throw new ValidationError(msg('admin.invalidCompositeCannotEnable'), renderIssues(def?.validationErrors, requestLocale(req)));
        }
        if (!canTransition(tool.state, to)) {
          await audit.record(tenantId, {
            action: `tool.${action}`,
            subject: principal.sub,
            clientId: principal.clientId,
            toolId: tool.id,
            toolName: toolDto(tool).name,
            decision: 'rejected',
            details: { from: tool.state, to },
          });
          throw new ValidationError(msg('admin.invalidTransition', { from: tool.state, to }), { from: tool.state, to });
        }
        const updated = await tools.setState(tenantId, tool.id, tool.state, to);
        // F7b.5: disabling a base tool invalidates the composites that depend on it.
        if (to === 'disabled' && tool.kind !== 'composite') {
          await services.repos.composites.invalidateDependents(tenantId, [{ id: tool.id, name: toolDto(tool).name, reason: msg('db.reasonDisabledByOwner') }]);
        }
        await audit.record(tenantId, {
          action: `tool.${action}`,
          subject: principal.sub,
          clientId: principal.clientId,
          toolId: tool.id,
          toolName: toolDto(updated).name,
          decision: 'applied',
          details: { from: tool.state, to },
        });
        return toolDto(updated);
      },
    });
  }
};
