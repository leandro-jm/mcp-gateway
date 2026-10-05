import { NotFound } from '@mcp-gateway/core';
import type { FastifyInstance } from 'fastify';
import { resolveContext, type McpRouteDeps } from '../mcp/routes';
import { generateSdk } from './generate';

/** `GET /sdk/:tenant.ts` and `GET /sdk/:tenant.d.ts` (F8.5): SDK of the tools the subject may use. */
export async function sdkRoutes(app: FastifyInstance, deps: McpRouteDeps): Promise<void> {
  app.get<{ Params: { file: string }; Querystring: { server?: string } }>('/sdk/:file', { schema: { hide: true } }, async (req, reply) => {
    const m = /^([a-z0-9][a-z0-9-]*)\.(d\.ts|ts)$/.exec(req.params.file);
    if (!m) throw new NotFound('sdk', req.params.file);
    const [, tenant, ext] = m;
    const ctx = await resolveContext(deps, req, req.query.server);
    if (ctx.snapshot.tenant.slug !== tenant) throw new NotFound('sdk', req.params.file);
    const base = deps.services.config.PUBLIC_URL.replace(/\/$/, '');
    const mcpUrl = req.query.server ? `${base}/mcp/s/${req.query.server}` : `${base}/mcp`;
    const { ts, dts } = generateSdk(deps.executor.listTools(ctx), { tenant: tenant!, mcpUrl });
    return reply.type('text/plain; charset=utf-8').header('cache-control', 'no-store').send(ext === 'ts' ? ts : dts);
  });
}
