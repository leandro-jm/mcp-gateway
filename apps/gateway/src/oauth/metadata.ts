import {
  authorizationServerMetadata,
  canonicalMcpResource,
  issuerOf,
  protectedResourceMetadata,
} from '@mcp-gateway/oauth';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Services } from '../services';

/** Discovery documents are public and read by browser-based clients too (MCP Inspector). */
export function publicCors(reply: FastifyReply, methods = 'GET, OPTIONS'): FastifyReply {
  return reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-methods', methods)
    .header('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version')
    .header('access-control-max-age', '600');
}

const PRM = '/.well-known/oauth-protected-resource';
const ASM = '/.well-known/oauth-authorization-server';

/**
 * Discovery (ADR-030): Protected Resource Metadata of the gateway and of each MCP surface
 * (RFC 9728) and the authorization server metadata (RFC 8414). With a base path in `PUBLIC_URL`,
 * the path-suffixed forms (`/.well-known/...<path>`) answer too.
 */
export async function oauthMetadataRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const { PUBLIC_URL, OAUTH_DCR_ENABLED } = services.config;
  const issuer = issuerOf(PUBLIC_URL);
  const basePath = new URL(issuer).pathname.replace(/\/$/, '');
  const asMetadata = authorizationServerMetadata({ publicUrl: PUBLIC_URL, registration: OAUTH_DCR_ENABLED });
  const opts = { schema: { hide: true } };

  const sendJson = (reply: FastifyReply, body: unknown) =>
    publicCors(reply).header('cache-control', 'public, max-age=300').type('application/json').send(body);

  const resourceDocument = (suffix: string) => {
    // the suffix is the resource path, which already includes the base path of PUBLIC_URL
    const resource = canonicalMcpResource(`${new URL(issuer).origin}${suffix}`, PUBLIC_URL);
    return resource ? protectedResourceMetadata({ publicUrl: PUBLIC_URL, resource }) : undefined;
  };

  app.get(PRM, opts, (_req, reply) => sendJson(reply, protectedResourceMetadata({ publicUrl: PUBLIC_URL, resource: issuer })));
  app.get<{ Params: { '*': string } }>(`${PRM}/*`, opts, (req, reply) => {
    const doc = resourceDocument(`/${req.params['*']}`);
    if (!doc) return publicCors(reply).code(404).send({ error: 'not_found' });
    return sendJson(reply, doc);
  });

  app.get(ASM, opts, (_req, reply) => sendJson(reply, asMetadata));
  if (basePath) app.get(`${ASM}${basePath}`, opts, (_req, reply) => sendJson(reply, asMetadata));

  for (const url of [PRM, `${PRM}/*`, ASM, ...(basePath ? [`${ASM}${basePath}`] : [])]) {
    app.options(url, opts, (_req, reply) => publicCors(reply).code(204).send());
  }
}
