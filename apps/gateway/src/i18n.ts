import { negotiate, type Locale } from '@mcp-gateway/i18n';
import type { FastifyRequest } from 'fastify';

/**
 * Locale of a request (ADR-012): the authenticated user's profile, then `Accept-Language`
 * (unauthenticated requests such as login and 401s), then English.
 */
export function requestLocale(req: FastifyRequest): Locale {
  return req.principal?.locale ?? negotiate(req.headers['accept-language']);
}
