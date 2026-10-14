import { createHash } from 'node:crypto';
import type { CallEndpoint, SessionSource } from '@mcp-gateway/call-analytics';
import { isGatewayError, NotFound, readObservabilitySettings, Unauthorized } from '@mcp-gateway/core';
import { msg, translate, type ServerMessage } from '@mcp-gateway/i18n/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { bearerToken, wwwAuthenticate, type Principal } from '../auth/tokens';
import { requestLocale } from '../i18n';
import type { CallContext, CallIdentity, ToolExecutor } from '../proxy/executor';
import type { ToolSearch } from '../search/tool-search';
import { createOmniServer } from './omni';
import type { SessionStore } from './sessions';
import { findVirtualServer } from '../registry/catalog';
import type { Services } from '../services';
import { createObservabilityServer } from './observability';
import { outcomeHandler, parseOutcome, reportOutcome } from './outcomes';
import { createMcpServer } from './server';
import { withHeaderTrace } from './call-context';
import { classify, McpSurface } from './surface';
import { clientInfoOf, isStatelessSessionId, issueSessionId, parseSessionId, type AgentInfo } from './session-id';

export interface McpRouteDeps {
  services: Services;
  executor: ToolExecutor;
  search: ToolSearch;
  sessions: SessionStore;
}

/** The MCP surfaces of one app instance (ADR-021): each serves both protocol eras. */
interface Surfaces {
  native: McpSurface;
  omni: McpSurface;
  observability: McpSurface;
}

function createSurfaces(deps: McpRouteDeps): Surfaces {
  const omniDeps = { executor: deps.executor, search: deps.search, artifacts: deps.services.artifacts, outcomes: outcomeHandler(deps.services) };
  return {
    native: new McpSurface((ctx) => createMcpServer(deps.executor, ctx, deps.services.artifacts, outcomeHandler(deps.services))),
    omni: new McpSurface((ctx) => createOmniServer(omniDeps, () => ctx, { dynamic: false, discovered: new Set() })),
    observability: new McpSurface((ctx) => createObservabilityServer(deps.services, ctx)),
  };
}

function jsonRpcError(reply: FastifyReply, status: number, code: number, message: string, headers: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(headers)) reply.header(k, v);
  return reply.code(status).send({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/** JSON-RPC error with a gateway message rendered in the request locale (principal, then `Accept-Language`). */
function localizedError(req: FastifyRequest, reply: FastifyReply, status: number, code: number, message: ServerMessage, headers?: Record<string, string>) {
  return jsonRpcError(reply, status, code, translate(message, requestLocale(req)), headers);
}

/**
 * Authenticates the agent (opaque token, ADR-011). The per-tool policy is enforced in the executor.
 * Sets `req.principal` so the global error handler also renders errors in the principal's locale.
 */
async function authenticate(services: Services, req: FastifyRequest): Promise<Principal> {
  const token = bearerToken(req.headers.authorization);
  if (!token) throw new Unauthorized(msg('mcp.missingBearer'));
  const principal = await services.verifier.verify(token);
  req.principal = principal;
  return principal;
}

/**
 * Artifact session (ADR-010): `mcp-session-id` when present; otherwise, the caller's stable
 * identity (tenant + sub + client). The client chooses the session id, so it is always bound to
 * the caller's `sub`: replaying someone else's id reaches an empty session.
 */
export function sessionKeyOf(req: FastifyRequest, tenantId: string, p: Principal): string {
  return sessionOf(req, tenantId, p).key;
}

/** Session key and where it came from (the client header or the principal itself). */
export function sessionOf(req: FastifyRequest, tenantId: string, p: Principal): { key: string; source: SessionSource } {
  const sid = req.headers['mcp-session-id'];
  if (typeof sid === 'string' && sid) {
    return { key: `s-${createHash('sha256').update(`${tenantId}:${p.sub}:${sid}`).digest('hex').slice(0, 32)}`, source: 'header' };
  }
  return { key: `p-${createHash('sha256').update(`${tenantId}:${p.sub}:${p.clientId ?? ''}`).digest('hex').slice(0, 32)}`, source: 'principal' };
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) || undefined;
};

/** Identity of the caller as seen by analytics: endpoint, session origin and the agent (ADR-016 §10). */
function identityOf(req: FastifyRequest, endpoint: CallEndpoint, source: SessionSource): CallIdentity {
  const agent = parseSessionId(header(req, 'mcp-session-id'));
  const protocolVersion = header(req, 'mcp-protocol-version')?.slice(0, 32);
  return {
    endpoint,
    sessionSource: source,
    ...(agent?.name ? { agentName: agent.name } : {}),
    ...(agent?.version ? { agentVersion: agent.version } : {}),
    ...(protocolVersion ? { protocolVersion } : {}),
  };
}

/**
 * Issues the stateless session id on `initialize` (ADR-016 §10). The header set on the raw
 * response is merged with the ones the transport writes.
 */
function maybeIssueSessionId(ctx: CallContext, req: FastifyRequest, reply: FastifyReply): void {
  if (header(req, 'mcp-session-id')) return;
  const agent = clientInfoOf(req.body);
  if (!agent || !readObservabilitySettings(ctx.snapshot.tenant.settings).issueSessionId) return;
  reply.raw.setHeader('mcp-session-id', issueSessionId(agent));
}

export async function resolveContext(
  deps: McpRouteDeps,
  req: FastifyRequest,
  serverSlug?: string,
): Promise<CallContext> {
  const principal = await authenticate(deps.services, req);
  if (!principal.tenant) throw new Unauthorized(msg('mcp.userWithoutTenant'));
  // Optional header pinning the expected tenant; a token from another tenant is rejected.
  const expected = req.headers['x-tenant'];
  if (typeof expected === 'string' && expected && expected !== principal.tenant) {
    throw new Unauthorized(msg('mcp.tokenOtherTenant'));
  }
  const snapshot = await deps.services.registry.getBySlug(principal.tenant).catch((err: unknown) => {
    if (err instanceof NotFound) throw new Unauthorized(msg('mcp.tenantNotFound'));
    throw err;
  });
  if (snapshot.tenant.status !== 'active') {
    throw new Unauthorized(msg('mcp.tenantInactive', { tenant: snapshot.tenant.slug, status: snapshot.tenant.status }));
  }
  const session = sessionOf(req, snapshot.tenant.id, principal);
  const ctx: CallContext = {
    tenantId: snapshot.tenant.id,
    principal,
    snapshot,
    requestId: req.id,
    sessionKey: session.key,
    identity: identityOf(req, serverSlug ? 'server' : 'mcp', session.source),
  };
  if (serverSlug) {
    const vs = findVirtualServer(snapshot, serverSlug);
    if (!vs) throw new NotFound('mcpServer', serverSlug);
    ctx.virtualServer = vs;
  }
  return withHeaderTrace(ctx, req.headers);
}

async function contextOrReply(deps: McpRouteDeps, req: FastifyRequest, reply: FastifyReply, serverSlug?: string) {
  try {
    return await resolveContext(deps, req, serverSlug);
  } catch (err) {
    if (err instanceof Unauthorized) {
      const hasToken = Boolean(bearerToken(req.headers.authorization));
      // The body follows the request locale; the WWW-Authenticate error_description stays English.
      localizedError(req, reply, 401, -32001, err.msg, {
        'www-authenticate': wwwAuthenticate(hasToken ? 'invalid_token' : undefined, hasToken ? err.message : undefined),
      });
      return undefined;
    }
    if (isGatewayError(err)) {
      localizedError(req, reply, err.httpStatus, -32002, err.msg);
      return undefined;
    }
    throw err;
  }
}

async function handleMcpPost(
  deps: McpRouteDeps,
  surfaces: Surfaces,
  req: FastifyRequest,
  reply: FastifyReply,
  serverSlug?: string,
  resolved?: CallContext,
) {
  const ctx = resolved ?? (await contextOrReply(deps, req, reply, serverSlug));
  if (!ctx) return reply;
  await surfaces.native.serve(req, reply, ctx, await classify(req), () => maybeIssueSessionId(ctx, req, reply));
  return reply;
}

const sessionHeader = (req: FastifyRequest) => {
  const v = req.headers['mcp-session-id'];
  return Array.isArray(v) ? v[0] : v;
};

function withEndpoint(ctx: CallContext, endpoint: CallEndpoint): CallContext {
  return ctx.identity ? { ...ctx, identity: { ...ctx.identity, endpoint } } : ctx;
}

const agentFields = (agent?: AgentInfo) => ({
  ...(agent?.name ? { agentName: agent.name } : {}),
  ...(agent?.version ? { agentVersion: agent.version } : {}),
});

const wantsDynamic = (req: FastifyRequest) =>
  req.headers['mcp-omni-mode'] === 'dynamic' || (req.query as Record<string, string> | undefined)?.mode === 'dynamic';

/**
 * `/mcp/omni` (F7.2). Stateless by default (3 meta-tools). With `mcp-omni-mode: dynamic`
 * (or `?mode=dynamic`) on initialize, creates a session: the tools found by the search join
 * the list and the client receives `tools/list_changed` on the GET stream.
 */
async function handleOmni(
  deps: McpRouteDeps,
  surfaces: Surfaces,
  req: FastifyRequest,
  reply: FastifyReply,
  serverSlug?: string,
  resolved?: CallContext,
) {
  const resolvedCtx = resolved ?? (await contextOrReply(deps, req, reply, serverSlug));
  if (!resolvedCtx) return reply;
  const ctx = withEndpoint(resolvedCtx, serverSlug ? 'server_omni' : 'omni');
  const path = req.url.split('?')[0]!;
  const rawSid = sessionHeader(req);
  // `mgs1_` ids are the stateless ones issued by the gateway itself, not Omni dynamic sessions.
  const stateless = isStatelessSessionId(rawSid);
  if (stateless && req.method !== 'POST') return localizedError(req, reply, 405, -32000, msg('mcp.methodNotAllowed'), { allow: 'POST' });
  const sid = stateless ? undefined : rawSid;

  if (sid) {
    const session = deps.sessions.get(sid);
    if (!session) return localizedError(req, reply, 404, -32001, msg('mcp.sessionNotFound'));
    if (session.owner.tenantId !== ctx.tenantId || session.owner.sub !== ctx.principal.sub || session.owner.path !== path) {
      return localizedError(req, reply, 403, -32003, msg('mcp.sessionOtherSubject'));
    }
    session.ctx = { ...ctx, identity: { ...ctx.identity!, sessionSource: 'omni', ...agentFields(session.agent) } };
    session.lastSeen = Date.now();
    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw, req.body);
    return reply;
  }

  if (req.method !== 'POST') return localizedError(req, reply, 400, -32000, msg('mcp.sessionIdRequired'));

  const cls = await classify(req);
  // Dynamic sessions (list_changed on the GET stream) exist only for 2025-era clients (ADR-021).
  if (cls.legacy && wantsDynamic(req)) {
    const omniDeps = { executor: deps.executor, search: deps.search, artifacts: deps.services.artifacts, outcomes: outcomeHandler(deps.services) };
    const omni = { dynamic: true, discovered: new Set<string>() };
    const agent = clientInfoOf(req.body);
    const sessionCtx = { ...ctx, identity: { ...ctx.identity!, sessionSource: 'omni' as const, ...agentFields(agent) } };
    const session = await deps.sessions.create({ tenantId: ctx.tenantId, sub: ctx.principal.sub, path }, sessionCtx, omni, (getCtx) =>
      createOmniServer(omniDeps, getCtx, omni),
    );
    if (agent) session.agent = agent;
    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw, req.body);
    return reply;
  }

  await surfaces.omni.serve(req, reply, ctx, cls, () => maybeIssueSessionId(ctx, req, reply));
  return reply;
}

const OBSERVABILITY_ROLES = ['gateway-admin', 'analytics-reader'];

/** `/mcp/observability` (F15.14): tenant analytics as MCP tools, for gateway-admin and analytics-reader. */
async function handleObservability(deps: McpRouteDeps, surfaces: Surfaces, req: FastifyRequest, reply: FastifyReply) {
  const resolved = await contextOrReply(deps, req, reply);
  if (!resolved) return reply;
  if (!resolved.principal.roles.some((r) => OBSERVABILITY_ROLES.includes(r))) {
    return localizedError(req, reply, 403, -32003, msg('mcp.obsForbidden'));
  }
  const ctx = withEndpoint(resolved, 'observability');
  await surfaces.observability.serve(req, reply, ctx, await classify(req), () => maybeIssueSessionId(ctx, req, reply));
  return reply;
}

export async function mcpRoutes(app: FastifyInstance, deps: McpRouteDeps): Promise<void> {
  const surfaces = createSurfaces(deps);
  app.addHook('onClose', async () => {
    await Promise.all([surfaces.native.close(), surfaces.omni.close(), surfaces.observability.close()]);
  });
  const methodNotAllowed = async (req: FastifyRequest, reply: FastifyReply) =>
    localizedError(req, reply, 405, -32000, msg('mcp.methodNotAllowed'), { allow: 'POST' });

  const opts = { schema: { hide: true } };
  app.post('/mcp', opts, (req, reply) => handleMcpPost(deps, surfaces, req, reply));
  // MCP self-service: the virtual server mode picks native tools or Omni.
  app.post<{ Params: { serverSlug: string } }>('/mcp/s/:serverSlug', opts, async (req, reply) => {
    const ctx = await contextOrReply(deps, req, reply, req.params.serverSlug);
    if (!ctx) return reply;
    if (ctx.virtualServer?.mode === 'omni') return handleOmni(deps, surfaces, req, reply, req.params.serverSlug, ctx);
    return handleMcpPost(deps, surfaces, req, reply, req.params.serverSlug, ctx);
  });
  app.post('/mcp/observability', opts, (req, reply) => handleObservability(deps, surfaces, req, reply));
  // report_outcome for orchestrators that know the outcome outside the model (F15.22)
  app.post('/v1/outcomes', opts, async (req, reply) => {
    const ctx = await contextOrReply(deps, req, reply);
    if (!ctx) return reply;
    try {
      return reply.code(201).send(await reportOutcome(deps.services, withEndpoint(ctx, 'api'), parseOutcome(req.body), 'api'));
    } catch (err) {
      if (isGatewayError(err)) return reply.code(err.httpStatus).send(err.toJSON(ctx.principal.locale));
      throw err;
    }
  });
  for (const url of ['/mcp', '/mcp/s/:serverSlug', '/mcp/observability']) {
    app.get(url, opts, methodNotAllowed);
    app.delete(url, opts, methodNotAllowed);
  }
  for (const method of ['GET', 'POST', 'DELETE'] as const) {
    app.route({ method, url: '/mcp/omni', ...opts, handler: (req, reply) => handleOmni(deps, surfaces, req, reply) });
    app.route<{ Params: { serverSlug: string } }>({
      method,
      url: '/mcp/s/:serverSlug/omni',
      ...opts,
      handler: (req, reply) => handleOmni(deps, surfaces, req, reply, req.params.serverSlug),
    });
  }
}
