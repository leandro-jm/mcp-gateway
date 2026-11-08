import type { FastifyInstance } from 'fastify';
import type { Services } from '../services';
import { authorizeRoutes } from './authorize';
import { OAuthClientResolver } from './clients';
import { registerFormParser } from './forms';
import { oauthMetadataRoutes } from './metadata';
import { PendingAuthorizations } from './pending';
import { tokenRoutes } from './token-endpoint';

/**
 * Authorization server for MCP clients (F20, ADR-030). Registered only with `OAUTH_ENABLED=true`;
 * the routes live at the root, outside the Admin API auth hook, and parse form bodies only here.
 */
export async function oauthRoutes(app: FastifyInstance, services: Services): Promise<void> {
  registerFormParser(app);
  const clients = new OAuthClientResolver(
    services.repos,
    services.redis,
    services.clientMetadataFetcher,
    { dcrEnabled: services.config.OAUTH_DCR_ENABLED },
    services.logger,
  );
  await oauthMetadataRoutes(app, services);
  await authorizeRoutes(app, services, { clients, pending: new PendingAuthorizations(services.redis) });
  await tokenRoutes(app, services);
}
