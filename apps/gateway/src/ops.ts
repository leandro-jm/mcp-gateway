import { timingSafeEqual } from 'node:crypto';
import { msg, translate } from '@mcp-gateway/i18n/server';
import type { FastifyInstance } from 'fastify';
import { bearerToken } from './auth/tokens';
import { requestLocale } from './i18n';
import type { Services } from './services';

type Check = () => Promise<void>;

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  let t: NodeJS.Timeout;
  return Promise.race([p.finally(() => clearTimeout(t)), new Promise<void>((_, reject) => (t = setTimeout(() => reject(new Error(`timeout ${ms} ms`)), ms)))]);
}

/** Readiness checks (F9.3): Postgres, Redis and S3 (when enabled). */
export function readinessChecks(services: Services): Record<string, Check> {
  const checks: Record<string, Check> = {
    postgres: async () => void (await services.dbHandle.pool.query('SELECT 1')),
    redis: async () => {
      if ((await services.redis.ping()) !== 'PONG') throw new Error('PING without PONG');
    },
  };
  if (services.artifacts.enabled) checks.s3 = () => services.artifacts.ping();
  return checks;
}

export async function opsRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const opts = { schema: { hide: true }, logLevel: 'warn' as const };

  app.get('/healthz', opts, async () => ({ status: 'ok' }));

  app.get('/readyz', opts, async (_req, reply) => {
    const results: Record<string, string> = {};
    await Promise.all(
      Object.entries(readinessChecks(services)).map(async ([name, check]) => {
        try {
          await withTimeout(check(), 2000);
          results[name] = 'ok';
        } catch (err) {
          // unauthenticated endpoint: the details (hosts, auth errors) go to the log only
          app.log.warn({ err, check: name }, 'readiness check failed');
          results[name] = 'fail';
        }
      }),
    );
    const ok = Object.values(results).every((r) => r === 'ok');
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not_ready', checks: results });
  });

  app.get('/metrics', opts, async (req, reply) => {
    const expected = services.config.METRICS_TOKEN;
    if (expected) {
      const got = bearerToken(req.headers.authorization) ?? '';
      const a = Buffer.from(got);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(401).send({ error: 'UNAUTHORIZED', message: translate(msg('auth.invalidMetricsToken'), requestLocale(req)) });
    }
    const { contentType, body } = await services.metrics.render();
    return reply.type(contentType).send(body);
  });
}
