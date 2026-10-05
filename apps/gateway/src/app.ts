import swagger from '@fastify/swagger';
import { isGatewayError } from '@mcp-gateway/core';
import { msg, translate } from '@mcp-gateway/i18n/server';
import Fastify, { type FastifyError, type FastifyInstance, type RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { adminApi } from './admin';
import { mcpRoutes } from './mcp/routes';
import { opsRoutes } from './ops';
import { sdkRoutes } from './sdk/routes';
import { requestLocale } from './i18n';
import type { Logger } from './logger';
import type { Services } from './services';

export const ADMIN_PREFIX = '/admin/v1';

export type GatewayApp = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>;

/** `TRUST_PROXY` as Fastify takes it: a hop count becomes the equivalent trust function. */
function trustProxy(v: boolean | number | string): boolean | string | ((addr: string, hop: number) => boolean) {
  return typeof v === 'number' ? (_addr, hop) => hop < v : v;
}

export async function buildApp(services: Services): Promise<GatewayApp> {
  const app = Fastify({
    loggerInstance: services.logger,
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: trustProxy(services.config.TRUST_PROXY),
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const locale = requestLocale(req);
    if (isGatewayError(err)) {
      return reply.code(err.httpStatus).send(err.toJSON(locale));
    }
    const internal = () => reply.code(500).send({ error: 'INTERNAL_ERROR', message: translate(msg('common.internalError'), locale) });
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: translate(msg('common.invalidRequest'), locale),
        details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      });
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err, issues: err.cause.issues }, 'response does not match the schema');
      return internal();
    }
    if (err.statusCode && err.statusCode < 500) {
      // Fastify's own errors (malformed JSON, payload too large...): English text from the library
      return reply.code(err.statusCode).send({ error: err.code ?? 'BAD_REQUEST', message: err.message });
    }
    req.log.error({ err }, 'unhandled error');
    return internal();
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'MCP Gateway Admin API',
        version: '1.0.0',
        description: 'MCP Gateway control plane: tenants, sources, credentials, tools and policies.',
      },
      servers: [{ url: services.config.PUBLIC_URL }],
      components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque' } },
      },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  await app.register(async (scope) => opsRoutes(scope, services));
  await app.register(adminApi, { prefix: ADMIN_PREFIX, services });
  const mcpDeps = { services, executor: services.executor, search: services.search, sessions: services.sessions };
  await app.register(async (scope) => mcpRoutes(scope, mcpDeps));
  await app.register(async (scope) => sdkRoutes(scope, mcpDeps));

  return app;
}
