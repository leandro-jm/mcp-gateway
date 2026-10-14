import { randomUUID } from 'node:crypto';
import { applyOverrides, Forbidden, NotFound } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import { ProtocolError as McpProtocolError } from '@modelcontextprotocol/server';
import { MCP_APPS_EXTENSION } from '@mcp-ui-kit/view-spec';
import { uiRequestOf } from '../../proxy/ui';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Principal } from '../../auth/tokens';
import { ProtocolError, type CallContext } from '../../proxy/executor';
import { requestLocale } from '../../i18n';
import type { Services } from '../../services';
import { isAdmin, requirePrincipal, resolveTenantId, ROLE } from '../auth';
import { driftEventSchema, driftQuery, errorResponses, mePatchSchema, meSchema, page, playgroundResultSchema, playgroundSchema, uuidParam } from '../schemas';
import { canManageTool } from './tools';

function parseResult(result: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown }): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = (result.content ?? []).find((c) => c.type === 'text')?.text;
  if (text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Admin UI support endpoints (F10): session, drift inbox and playground. */
export const uiRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const readers = { roles: [ROLE.admin, ROLE.owner] };

  app.get('/me', {
    config: readers,
    schema: { tags: ['ui'], response: { 200: meSchema, ...errorResponses } },
    handler: async (req) => {
      const p = requirePrincipal(req);
      const name = (p.claims.name ?? p.claims.preferred_username ?? null) as string | null;
      return { sub: p.sub, name, tenant: p.tenant ?? null, roles: p.roles, groups: p.groups, isAdmin: isAdmin(p), isOwner: p.roles.includes(ROLE.owner), locale: p.locale, publicUrl: services.config.PUBLIC_URL };
    },
  });

  app.patch('/me', {
    config: readers,
    schema: { tags: ['ui'], summary: "Updates the authenticated user's own preferences", body: mePatchSchema, response: { 200: meSchema, ...errorResponses } },
    handler: async (req) => {
      const p = requirePrincipal(req);
      if (!p.userId) throw new Forbidden();
      await services.repos.auth.setLocale(p.userId, req.body.locale);
      // every cached token of this user carries the old locale
      services.verifier.clear();
      const name = (p.claims.name ?? p.claims.preferred_username ?? null) as string | null;
      return { sub: p.sub, name, tenant: p.tenant ?? null, roles: p.roles, groups: p.groups, isAdmin: isAdmin(p), isOwner: p.roles.includes(ROLE.owner), locale: req.body.locale, publicUrl: services.config.PUBLIC_URL };
    },
  });

  app.get('/drift-events', {
    config: readers,
    schema: { tags: ['drift'], querystring: driftQuery, response: { 200: page(driftEventSchema), ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const events = await services.repos.drift.list(tenantId, req.query);
      const tools = new Map((await services.repos.tools.listAll(tenantId)).map((t) => [t.id, t]));
      const items = events.map((e) => {
        const t = tools.get(e.toolId);
        return {
          id: e.id,
          toolId: e.toolId,
          toolName: t ? applyOverrides(t).name : e.toolId,
          ownerTeam: t?.ownerTeam ?? null,
          kind: e.kind,
          diff: e.diff,
          acknowledgedBy: e.acknowledgedBy,
          acknowledgedAt: e.acknowledgedAt?.toISOString() ?? null,
          createdAt: e.createdAt.toISOString(),
        };
      });
      return { items, total: items.length };
    },
  });

  app.post('/drift-events/:id/ack', {
    config: readers,
    schema: { tags: ['drift'], params: uuidParam, response: { 200: driftEventSchema, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const p = requirePrincipal(req);
      const ev = await services.repos.drift.get(tenantId, req.params.id);
      const tool = await services.repos.tools.get(tenantId, ev.toolId);
      if (!canManageTool(p, tool)) throw new Forbidden(msg('admin.otherTeamDriftEvent'));
      const acked = await services.repos.drift.acknowledge(tenantId, ev.id, p.sub);
      return {
        id: acked.id,
        toolId: acked.toolId,
        toolName: applyOverrides(tool).name,
        ownerTeam: tool.ownerTeam,
        kind: acked.kind,
        diff: acked.diff,
        acknowledgedBy: acked.acknowledgedBy,
        acknowledgedAt: acked.acknowledgedAt?.toISOString() ?? null,
        createdAt: acked.createdAt.toISOString(),
      };
    },
  });

  app.post('/playground/call', {
    config: readers,
    schema: {
      tags: ['ui'],
      summary: 'Calls a tool as a simulated subject (full pipeline); raw response only for gateway-admin',
      body: playgroundSchema,
      response: { 200: playgroundResultSchema, ...errorResponses },
    },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const caller = requirePrincipal(req);
      const admin = isAdmin(caller);
      const snapshot = await services.registry.get(tenantId);
      const tool = snapshot.tools.find((t) => t.name === req.body.tool);
      if (!tool) throw new NotFound('tool', req.body.tool);
      // The call reaches the upstream for real, with the source's credential: owners only try their
      // own read-only tools, never as gateway-admin, and the audit keeps their identity.
      if (!admin) {
        if (!canManageTool(caller, tool)) throw new Forbidden(msg('admin.toolManageForbidden', { team: tool.ownerTeam ?? msg('admin.noTeam') }));
        if (tool.annotations?.readOnlyHint !== true) throw new Forbidden(msg('admin.playgroundReadOnly'));
        if (req.body.subject?.roles.includes(ROLE.admin)) throw new Forbidden(msg('admin.playgroundAdminSubject'));
      }
      const subject: Principal = req.body.subject
        ? {
            sub: admin ? req.body.subject.sub : caller.sub,
            tenant: snapshot.tenant.slug,
            roles: req.body.subject.roles,
            groups: req.body.subject.groups,
            clientId: admin ? req.body.subject.clientId : 'playground',
            claims: req.body.subject.claims as Principal['claims'],
            locale: caller.locale,
          }
        : caller;
      const capture: NonNullable<CallContext['capture']> = {};
      const ctx: CallContext = {
        tenantId,
        principal: subject,
        snapshot,
        requestId: randomUUID(),
        sessionKey: `playground-${caller.sub}`,
        capture,
        identity: { endpoint: 'playground', sessionSource: 'principal' },
        ...(req.body.ui ? { client: { era: 'modern' as const, name: 'playground', extensions: [MCP_APPS_EXTENSION] } } : {}),
        ...(req.body.ui && uiRequestOf(req.body.meta) ? { ui: uiRequestOf(req.body.meta) } : {}),
      };
      const started = Date.now();
      let decision = 'allow';
      let result: Record<string, unknown>;
      try {
        result = (await services.executor.call(ctx, req.body.tool, req.body.arguments)) as Record<string, unknown>;
        if (result.isError) decision = 'error';
      } catch (err) {
        if (err instanceof ProtocolError || err instanceof McpProtocolError) {
          const e = err instanceof ProtocolError ? err.error.toJSON(requestLocale(req)) : { error: 'PROTOCOL', message: err.message };
          decision = e.error === 'TOOL_NOT_FOUND' ? 'deny' : 'error';
          result = { isError: true, content: [{ type: 'text', text: JSON.stringify(e) }] };
        } else throw err;
      }
      const rawVisible = admin;
      return {
        decision,
        result,
        final: parseResult(result as never),
        raw: rawVisible ? (capture.raw ?? null) : null,
        rawVisible,
        status: capture.status ?? null,
        redactions: capture.redactions ?? 0,
        bytesSaved: capture.bytesSaved ?? 0,
        artifactId: capture.artifactId ?? null,
        durationMs: Date.now() - started,
      };
    },
  });
};
