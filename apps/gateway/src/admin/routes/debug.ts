import { NotFound, ValidationError } from '@mcp-gateway/core';
import type { DebugCapture } from '@mcp-gateway/db';
import { msg } from '@mcp-gateway/i18n/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { replayCall } from '../../analytics/replay';
import type { Services } from '../../services';
import { requirePrincipal, resolveTenantId, ROLE } from '../auth';
import { callIdParam, debugCaptureBody, errorResponses, jsonObject, uuidParam } from '../schemas';

const captureDto = (c: DebugCapture) => ({
  id: c.id,
  createdBy: c.createdBy,
  reason: c.reason,
  filter: c.filter,
  maxCalls: c.maxCalls,
  capturedCount: c.capturedCount,
  status: c.status === 'active' && c.expiresAt < new Date() ? 'expired' : c.status,
  expiresAt: c.expiresAt.toISOString(),
  createdAt: c.createdAt.toISOString(),
});

/**
 * Debug capture (F15.17, ADR-017): gateway-admin only. Captures are opt-in, justified, capped and
 * short-lived; reading a captured call is audited.
 */
export const debugRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const tags = ['debug'];
  const admin = { roles: [ROLE.admin] };
  const repo = services.repos.debugCaptures;

  app.post('/debug-captures', {
    config: admin,
    schema: { tags, summary: 'Opens a debug capture (reason, filter, cap and expiry)', body: debugCaptureBody, response: { 201: jsonObject, ...errorResponses } },
    handler: async (req, reply) => {
      const tenantId = await resolveTenantId(services, req);
      if (!services.debug.enabled) throw new ValidationError(msg('analytics.captureUnavailable'));
      const max = services.config.DEBUG_CAPTURE_MAX_MINUTES;
      if (req.body.minutes > max) throw new ValidationError(msg('analytics.captureTooLong', { minutes: max }));
      const caller = requirePrincipal(req);
      const c = await repo.create(tenantId, {
        createdBy: caller.sub,
        reason: req.body.reason,
        filter: req.body.filter,
        maxCalls: req.body.maxCalls,
        expiresAt: new Date(Date.now() + req.body.minutes * 60_000),
      });
      services.debug.invalidate(tenantId);
      await services.repos.audit.record(tenantId, {
        action: 'debug.capture.create',
        subject: caller.sub,
        decision: 'applied',
        details: { captureId: c.id, reason: c.reason, maxCalls: c.maxCalls, minutes: req.body.minutes, filter: c.filter },
      });
      return reply.code(201).send(captureDto(c));
    },
  });

  app.get('/debug-captures', {
    config: admin,
    schema: { tags, summary: 'Debug captures of the tenant', response: { 200: z.object({ items: z.array(jsonObject), enabled: z.boolean() }), ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      return { enabled: services.debug.enabled, items: (await repo.list(tenantId)).map(captureDto) };
    },
  });

  app.get('/debug-captures/:id/items', {
    config: admin,
    schema: { tags, summary: 'Calls captured by a debug capture', params: uuidParam, response: { 200: z.object({ items: z.array(jsonObject) }), ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      if (!(await repo.get(tenantId, req.params.id))) throw new NotFound('debugCapture', req.params.id);
      const items = await repo.items(tenantId, req.params.id);
      return { items: items.map((i) => ({ callId: i.callId, tool: i.toolName, sizeBytes: i.sizeBytes, expiresAt: i.expiresAt.toISOString(), createdAt: i.createdAt.toISOString() })) };
    },
  });

  app.delete('/debug-captures/:id', {
    config: admin,
    schema: { tags, summary: 'Stops a debug capture', params: uuidParam, response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const c = await repo.stop(tenantId, req.params.id);
      if (!c) throw new NotFound('debugCapture', req.params.id);
      services.debug.invalidate(tenantId);
      await services.repos.audit.record(tenantId, { action: 'debug.capture.stop', subject: requirePrincipal(req).sub, decision: 'applied', details: { captureId: c.id } });
      return captureDto(c);
    },
  });

  app.post('/calls/:callId/replay', {
    config: admin,
    schema: { tags, summary: 'Replays a captured call with the current configuration over the recorded upstream response', params: callIdParam, response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const caller = requirePrincipal(req);
      return replayCall(services, tenantId, req.params.callId, caller.locale, caller.sub);
    },
  });

  app.get('/calls/:callId/debug', {
    config: admin,
    schema: { tags, summary: 'Raw × final of a captured call (audited)', params: callIdParam, response: { 200: jsonObject, ...errorResponses } },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const captured = await services.debug.read(tenantId, req.params.callId);
      if (!captured) throw new NotFound('call', req.params.callId);
      await services.repos.audit.record(tenantId, { action: 'debug.view', subject: requirePrincipal(req).sub, decision: 'allow', callId: req.params.callId, toolName: captured.tool });
      return captured as unknown as Record<string, unknown>;
    },
  });
};
