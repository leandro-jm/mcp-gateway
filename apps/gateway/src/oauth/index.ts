import type { FastifyInstance } from 'fastify';
import type { Services } from '../services';
import { oauthMetadataRoutes } from './metadata';

/**
 * Authorization server for MCP clients (F20, ADR-030). Registered only with `OAUTH_ENABLED=true`;
 * the routes live at the root, outside the Admin API auth hook.
 */
export async function oauthRoutes(app: FastifyInstance, services: Services): Promise<void> {
  await oauthMetadataRoutes(app, services);
}
