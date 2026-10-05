import { Forbidden } from '@mcp-gateway/core';
import type { VirtualServer } from '@mcp-gateway/db';
import { DEFAULT_LOCALE, type Locale } from '@mcp-gateway/i18n';
import { msg, translate } from '@mcp-gateway/i18n/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requestLocale } from '../../i18n';
import type { Services } from '../../services';
import { isAdmin, requirePrincipal, resolveTenantId, ROLE } from '../auth';
import { virtualServerDto } from '../dto';
import {
  errorResponses,
  noContent,
  snippetsSchema,
  uuidParam,
  virtualServerCreateSchema,
  virtualServerPatchSchema,
  virtualServerSchema,
} from '../schemas';

/**
 * Configuration snippets for MCP clients (F7b.6). They all use a static API token
 * (ADR-011), generated in the Admin UI (Tokens) and sent in `Authorization: Bearer`.
 * Comments and placeholders are rendered in `locale`.
 */
export function connectionSnippets(vs: Pick<VirtualServer, 'slug' | 'name' | 'mode'>, publicUrl: string, locale: Locale = DEFAULT_LOCALE) {
  const base = publicUrl.replace(/\/$/, '');
  const mcp = `${base}/mcp/s/${vs.slug}`;
  const omni = `${mcp}/omni`;
  const url = vs.mode === 'omni' ? omni : mcp;
  const claudeJson = {
    mcpServers: { [vs.slug]: { type: 'http', url, headers: { Authorization: 'Bearer ${MCP_GATEWAY_TOKEN}' } } },
  };
  return {
    endpoints: { mcp, omni },
    snippets: {
      claude: `claude mcp add --transport http ${vs.slug} ${url} --header "Authorization: Bearer $MCP_GATEWAY_TOKEN"`,
      claudeJson,
      generic: [
        `# ${translate(msg('admin.snippetTokenComment'), locale)}`,
        `TOKEN=<mgw_...>`,
        `# initialize (Streamable HTTP)`,
        `curl -s ${url} -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \\`,
        `  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"cli","version":"1"}}}'`,
      ].join('\n'),
    },
  };
}

export const virtualServerRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const repo = services.repos.virtualServers;
  const config = { roles: [ROLE.admin, ROLE.owner] };
  const tags = ['virtual-servers'];
  const publicUrl = services.config.PUBLIC_URL;
  const dto = (v: VirtualServer) => virtualServerDto(v, publicUrl);

  /**
   * Owners manage only their own team's MCPs; admins manage all of them. An MCP without a team
   * belongs to the admins (its instructions reach every connected agent).
   */
  async function managed(req: Parameters<typeof resolveTenantId>[1], id: string) {
    const tenantId = await resolveTenantId(services, req);
    const vs = await repo.get(tenantId, id);
    const p = requirePrincipal(req);
    if (!isAdmin(p) && !(vs.ownerTeam && p.groups.includes(vs.ownerTeam))) throw new Forbidden(msg('admin.otherTeamMcp'));
    return { tenantId, vs, p };
  }

  app.get('/virtual-servers', {
    config,
    schema: { tags, response: { 200: z.object({ items: z.array(virtualServerSchema) }), ...errorResponses } },
    handler: async (req) => ({ items: (await repo.list(await resolveTenantId(services, req))).map(dto) }),
  });

  app.post('/virtual-servers', {
    config,
    schema: { tags, summary: 'Creates a self-service MCP (virtual server)', body: virtualServerCreateSchema, response: { 201: virtualServerSchema, ...errorResponses } },
    handler: async (req, reply) => {
      const tenantId = await resolveTenantId(services, req);
      const p = requirePrincipal(req);
      const ownerTeam = req.body.ownerTeam ?? (isAdmin(p) ? null : (p.groups[0] ?? null));
      if (!isAdmin(p) && !(ownerTeam && p.groups.includes(ownerTeam))) throw new Forbidden(msg('admin.ownerOwnTeamMcp'));
      return reply.code(201).send(dto(await repo.create(tenantId, { ...req.body, ownerTeam })));
    },
  });

  app.get('/virtual-servers/:id', {
    config,
    schema: { tags, params: uuidParam, response: { 200: virtualServerSchema, ...errorResponses } },
    handler: async (req) => dto(await repo.get(await resolveTenantId(services, req), req.params.id)),
  });

  app.get('/virtual-servers/:id/snippets', {
    config,
    schema: { tags, summary: 'Connection snippets (Claude, generic)', params: uuidParam, response: { 200: snippetsSchema, ...errorResponses } },
    handler: async (req) => {
      const vs = await repo.get(await resolveTenantId(services, req), req.params.id);
      return connectionSnippets(vs, publicUrl, requestLocale(req));
    },
  });

  app.patch('/virtual-servers/:id', {
    config,
    schema: { tags, params: uuidParam, body: virtualServerPatchSchema, response: { 200: virtualServerSchema, ...errorResponses } },
    handler: async (req) => {
      const { tenantId, vs, p } = await managed(req, req.params.id);
      // handing the MCP to another team (or to none) is also a change the owner must be entitled to
      if (!isAdmin(p) && req.body.ownerTeam !== undefined && !(req.body.ownerTeam && p.groups.includes(req.body.ownerTeam))) {
        throw new Forbidden(msg('admin.ownerOwnTeamMcp'));
      }
      return dto(await repo.update(tenantId, vs.id, req.body));
    },
  });

  app.delete('/virtual-servers/:id', {
    config,
    schema: { tags, params: uuidParam, response: { ...noContent, ...errorResponses } },
    handler: async (req, reply) => {
      const { tenantId, vs } = await managed(req, req.params.id);
      await repo.delete(tenantId, vs.id);
      return reply.code(204).send(null);
    },
  });
};
