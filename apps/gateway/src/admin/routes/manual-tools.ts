import { Forbidden, NotFound, ValidationError } from '@mcp-gateway/core';
import type { Source } from '@mcp-gateway/db';
import { buildManualTool, ManualToolError, type ManualToolSpec } from '@mcp-gateway/openapi-toolgen';
import { msg } from '@mcp-gateway/i18n/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { z } from 'zod';
import type { Principal } from '../../auth/tokens';
import type { Services } from '../../services';
import { isAdmin, requirePrincipal, resolveTenantId, ROLE } from '../auth';
import { toolDto } from '../dto';
import { errorResponses, manualToolSchema, toolSchema, uuidParam } from '../schemas';
import { canManageTool } from './tools';

type ManualBody = z.output<typeof manualToolSchema>;

/**
 * Annotations drive policy (`annotation:readOnlyHint` rules, destructive tools need an explicit
 * allow), so only gateway-admin may declare them; for owners they follow the HTTP method.
 */
function build(body: ManualBody, admin: boolean) {
  try {
    return buildManualTool({ ...body, ...(admin ? {} : { annotations: undefined }) } as ManualToolSpec);
  } catch (err) {
    if (err instanceof ManualToolError) throw new ValidationError(err.msg);
    throw err;
  }
}

/** A manual tool calls the source with its credential: owners only build on their team's sources. */
function assertCanUseSource(principal: Principal, source: Pick<Source, 'ownerTeam'>): void {
  if (!canManageTool(principal, source)) throw new Forbidden(msg('admin.sourceManageForbidden', { team: source.ownerTeam ?? msg('admin.noTeam') }));
}

export const manualToolRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const { tools, sources, audit } = services.repos;
  const config = { roles: [ROLE.admin, ROLE.owner] };
  const tags = ['tools'];

  app.post('/tools/manual', {
    config,
    schema: {
      tags,
      summary: 'Creates a manual tool (endpoint without OpenAPI); starts disabled',
      body: manualToolSchema,
      response: { 201: toolSchema, ...errorResponses },
    },
    handler: async (req, reply) => {
      const tenantId = await resolveTenantId(services, req);
      const principal = requirePrincipal(req);
      const source = await sources.get(tenantId, req.body.sourceId);
      assertCanUseSource(principal, source);
      const ownerTeam = req.body.ownerTeam ?? source.ownerTeam;
      if (!canManageTool(principal, { ownerTeam })) throw new ValidationError(msg('admin.ownerOwnTeamTool'));
      const b = build(req.body, isAdmin(principal));
      const tool = await tools.create(tenantId, {
        kind: 'manual',
        sourceId: source.id,
        operationKey: null,
        name: req.body.name,
        title: req.body.title ?? null,
        description: req.body.description,
        operationRef: b.operationRef,
        inputSchema: b.inputSchema,
        outputSchema: b.outputSchema,
        annotations: b.annotations,
        state: 'disabled',
        ownerTeam,
        tags: ['manual', source.name],
      });
      await audit.record(tenantId, {
        action: 'tool.create_manual',
        subject: principal.sub,
        clientId: principal.clientId,
        toolId: tool.id,
        toolName: tool.name,
        decision: 'applied',
      });
      return reply.code(201).send(toolDto(tool));
    },
  });

  app.put('/tools/:id/manual', {
    config,
    schema: {
      tags,
      summary: 'Updates the definition of a manual tool (creates a new version)',
      params: uuidParam,
      body: manualToolSchema,
      response: { 200: toolSchema, ...errorResponses },
    },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const principal = requirePrincipal(req);
      const current = await tools.get(tenantId, req.params.id);
      if (current.kind !== 'manual') throw new NotFound('manualTool', req.params.id);
      if (!canManageTool(principal, current) && !isAdmin(principal)) throw new NotFound('manualTool', req.params.id);
      const source = await sources.get(tenantId, req.body.sourceId);
      assertCanUseSource(principal, source);
      const b = build(req.body, isAdmin(principal));
      const updated = await tools.update(
        tenantId,
        current.id,
        {
          sourceId: source.id,
          name: req.body.name,
          title: req.body.title ?? null,
          description: req.body.description,
          operationRef: b.operationRef,
          inputSchema: b.inputSchema,
          outputSchema: b.outputSchema,
          annotations: b.annotations,
          version: current.version + 1,
        },
        { diff: { summary: 'manual definition updated', by: principal.sub } },
      );
      return toolDto(updated);
    },
  });
};
