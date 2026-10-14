import { NodeStreamableHTTPServerTransport, toWebRequest } from '@modelcontextprotocol/node';
import { createMcpHandler, isLegacyRequest, type AuthInfo, type McpHttpHandler, type Server } from '@modelcontextprotocol/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CallContext } from '../proxy/executor';
import { legacyClient } from './call-context';

/** Key of the resolved `CallContext` inside the pass-through `authInfo.extra` (never sent anywhere). */
const CTX_KEY = 'io.github.leandro-jm.mcp-gateway/ctx';

/** Era of one request, decided by the SDK's own classifier (ADR-021). */
export interface Classified {
  legacy: boolean;
  request: Request;
}

export async function classify(req: FastifyRequest): Promise<Classified> {
  const request = await toWebRequest(req.raw, req.body);
  return { request, legacy: await isLegacyRequest(request, req.body) };
}

/** The route already authenticated the caller: the SDK only carries the context to the factory. */
function authInfoOf(ctx: CallContext): AuthInfo {
  return { token: '', clientId: ctx.principal.clientId ?? ctx.principal.sub, scopes: [], extra: { [CTX_KEY]: ctx } };
}

function contextOf(authInfo: AuthInfo | undefined): CallContext {
  const ctx = authInfo?.extra?.[CTX_KEY] as CallContext | undefined;
  if (!ctx) throw new Error('MCP request without a resolved call context');
  return ctx;
}

/**
 * One MCP surface (`/mcp`, `/mcp/omni`, `/mcp/observability`…) served on both protocol eras
 * (ADR-021). 2026-07-28 requests go through the SDK's `createMcpHandler` (strict, JSON
 * responses); 2025-era requests keep the stateless JSON transport of ADR-001. Either way, a
 * fresh low-level `Server` is built per request from the caller's context, because the catalog
 * is dynamic per tenant, subject and virtual server.
 */
export class McpSurface {
  private readonly modern: McpHttpHandler;

  constructor(private readonly build: (ctx: CallContext) => Server) {
    this.modern = createMcpHandler((rc) => build(contextOf(rc.authInfo)), { legacy: 'reject', responseMode: 'json' });
  }

  /**
   * Serves one request. `beforeLegacy` runs before the 2025-era transport writes its response
   * (e.g. to add the stateless session id header on `initialize`).
   */
  async serve(req: FastifyRequest, reply: FastifyReply, ctx: CallContext, cls: Classified, beforeLegacy?: () => void): Promise<void> {
    reply.hijack();
    if (cls.legacy) {
      beforeLegacy?.();
      const server = this.build({ ...ctx, client: legacyClient(ctx.identity?.protocolVersion) });
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      reply.raw.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
      return;
    }
    const res = await this.modern.fetch(cls.request, { authInfo: authInfoOf(ctx), parsedBody: req.body });
    reply.raw.writeHead(res.status, Object.fromEntries(res.headers.entries()));
    reply.raw.end(Buffer.from(await res.arrayBuffer()));
  }

  close(): Promise<void> {
    return this.modern.close();
  }
}
