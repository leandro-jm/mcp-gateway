import { Forbidden, NotFound, Unauthorized, ValidationError } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { bearerToken, type Principal } from '../auth/tokens';
import type { Services } from '../services';

export const ROLE = {
  admin: 'gateway-admin',
  owner: 'tool-owner',
  agent: 'agent',
  /** Reads analytics and uses the observability MCP (F15, ADR-011 addendum). */
  analyticsReader: 'analytics-reader',
} as const;

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    /** Tenant affected by the request; successful mutations invalidate its snapshot. */
    affectedTenantId?: string;
  }
  interface FastifyContextConfig {
    /** Roles accepted by the route (any of them). Absent = authentication only. */
    roles?: string[];
    /** Public route (no auth). */
    public?: boolean;
  }
}

export function isAdmin(p: Principal): boolean {
  return p.roles.includes(ROLE.admin);
}

/** Platform admin: `gateway-admin` without a tenant. A `gateway-admin` with a tenant administers only that tenant (ADR-008). */
export function isPlatformAdmin(p: Principal): boolean {
  return isAdmin(p) && p.tenant === undefined;
}

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw new Unauthorized();
  return req.principal;
}

/**
 * Resolves the target tenant: `X-Tenant` header (slug) or the tenant of the token's user.
 * Only the platform admin may target a tenant other than its own, and it always sends `X-Tenant`.
 */
export async function resolveTenantId(services: Services, req: FastifyRequest): Promise<string> {
  const p = requirePrincipal(req);
  const header = req.headers['x-tenant'];
  const requested = (Array.isArray(header) ? header[0] : header)?.trim() || p.tenant;
  if (!requested) throw new ValidationError(msg('auth.tenantRequired'));
  if (requested !== p.tenant && !isPlatformAdmin(p)) throw new Forbidden(msg('auth.crossTenantForbidden'));
  const tenant = await services.repos.tenants.findBySlug(requested);
  if (!tenant) throw new NotFound('tenant', requested);
  if (tenant.status !== 'active') throw new Forbidden(msg('auth.tenantInactive', { tenant: requested, status: tenant.status }));
  req.affectedTenantId = tenant.id;
  return tenant.id;
}

/** Authenticates every route in the scope (except `config.public`) and checks `config.roles`. */
export const adminAuth = fp(async (app: FastifyInstance, opts: { services: Services }) => {
  app.addHook('onRequest', async (req) => {
    const cfg = req.routeOptions.config;
    if (cfg?.public) return;
    const token = bearerToken(req.headers.authorization);
    if (!token) throw new Unauthorized(msg('auth.missingBearer'));
    req.principal = await opts.services.verifier.verify(token);
    const roles = cfg?.roles;
    if (roles && !roles.some((r) => req.principal!.roles.includes(r))) {
      throw new Forbidden(msg('auth.requiresRole', { roles: roles.join(', ') }));
    }
  });

  // Invalidate the registry snapshot before replying, so the next read already sees the change.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method !== 'GET' && reply.statusCode < 400 && req.affectedTenantId) {
      await opts.services.registry.invalidate(req.affectedTenantId);
    }
    return payload;
  });
});
