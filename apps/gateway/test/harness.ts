import { Writable } from 'node:stream';
import { generateApiToken, generateDataKey } from '@mcp-gateway/core';
import { migrateUp, type JsonObject, type User } from '@mcp-gateway/db';
import type { Locale } from '@mcp-gateway/i18n';
import { startMinio, startPostgres, startRedis, type StartedMinio, type StartedPostgres, type StartedRedis } from '@mcp-gateway/testkit';
import { buildApp, type GatewayApp } from '../src/app';
import { loadConfig, type GatewayConfig } from '../src/config';
import { createLogger } from '../src/logger';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { LlmProviderFactory } from '../src/llm';
import type { EmbeddingProvider } from '../src/search/embeddings';
import { createServices, type Services } from '../src/services';

/**
 * Profile of the test token owner. Known fields become user columns; the others become
 * `attributes` (exposed to policies as `claims.*`). An explicit `tenant: undefined` creates
 * a platform user (requires the `gateway-admin` role). `locale` defaults to `en`.
 */
export interface TestTokenClaims {
  sub?: string;
  tenant?: string;
  roles?: string[];
  groups?: string[];
  client_id?: string;
  azp?: string;
  name?: string;
  locale?: Locale;
  [attr: string]: unknown;
}

export interface TestTokenOptions {
  /** Relative expiry (`'5m'`, `'-1m'` for already expired). No value: never expires. */
  expiresIn?: string;
}

export interface Harness {
  app: GatewayApp;
  services: Services;
  config: GatewayConfig;
  logs: string[];
  token(claims?: TestTokenClaims, opts?: TestTokenOptions): Promise<string>;
  adminToken(tenant?: string): Promise<string>;
  teardown(): Promise<void>;
}

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function expiresAt(expiresIn: string | undefined): Date | null {
  if (!expiresIn) return null;
  const m = /^(-?)(\d+)([smhd])$/.exec(expiresIn);
  if (!m) throw new Error(`invalid expiresIn: ${expiresIn}`);
  const ms = Number(m[2]) * UNITS[m[3]!]!;
  return new Date(Date.now() + (m[1] ? -ms : ms));
}

const sameProfile = (
  u: User,
  p: { tenantId: string | null; roles: string[]; groups: string[]; attributes: JsonObject; displayName: string | null; locale: Locale },
) =>
  u.tenantId === p.tenantId &&
  u.locale === p.locale &&
  u.displayName === p.displayName &&
  JSON.stringify(u.roles) === JSON.stringify(p.roles) &&
  JSON.stringify(u.groups) === JSON.stringify(p.groups) &&
  JSON.stringify(u.attributes) === JSON.stringify(p.attributes);

/**
 * Creates (or reuses) the user described by the claims and issues an opaque token for it.
 * If the `sub` already exists with another profile, creates a new user (`sub~2`, `sub~3`...) so
 * tokens issued earlier are not changed.
 */
export async function mintToken(
  services: Services,
  claims: TestTokenClaims = {},
  opts: TestTokenOptions & { createTenant?: boolean } = {},
): Promise<string> {
  const { sub = 'user-1', tenant = 'dev', roles = ['agent'], groups = [], client_id, azp = 'agent-dev', name, locale = 'en', ...attributes } = claims;
  const platform = 'tenant' in claims && claims.tenant === undefined;
  let tenantId: string | null = null;
  if (!platform) {
    const found = await services.repos.tenants.findBySlug(tenant);
    if (found) tenantId = found.id;
    else if (opts.createTenant !== false) tenantId = (await services.repos.tenants.create({ slug: tenant, name: tenant })).id;
  }
  const { auth } = services.repos;
  const profile = { tenantId, roles, groups, attributes: attributes as JsonObject, displayName: name ?? null, locale };
  let user: User | undefined;
  for (let i = 1; !user; i++) {
    const username = i === 1 ? sub : `${sub}~${i}`;
    const existing = await auth.findUser(username);
    if (!existing) user = await auth.createUser(tenantId, { username, ...profile });
    else if (sameProfile(existing, profile)) user = existing;
  }
  const t = generateApiToken();
  await auth.createToken(user.id, { name: client_id ?? azp, tokenHash: t.hash, prefix: t.prefix, expiresAt: expiresAt(opts.expiresIn) });
  return t.token;
}

export interface Infra {
  pg: StartedPostgres;
  redis: StartedRedis;
  minio?: StartedMinio;
  stop(): Promise<void>;
}

export async function startInfra(opts: { minio?: boolean } = {}): Promise<Infra> {
  const [pg, redis, minio] = await Promise.all([startPostgres(), startRedis(), opts.minio ? startMinio() : undefined]);
  return {
    pg,
    redis,
    ...(minio ? { minio } : {}),
    stop: async () => void (await Promise.all([pg.stop(), redis.stop(), minio?.stop()])),
  };
}

export function s3Env(infra: Infra): Record<string, string> {
  if (!infra.minio) return {};
  return {
    S3_ENDPOINT: infra.minio.endpoint,
    S3_ACCESS_KEY: infra.minio.accessKey,
    S3_SECRET_KEY: infra.minio.secretKey,
    S3_BUCKET: 'mcp-artifacts',
  };
}

export async function startHarness(
  opts: { infra?: Infra; env?: Record<string, string>; embeddings?: EmbeddingProvider; spanProcessors?: SpanProcessor[]; llm?: LlmProviderFactory } = {},
): Promise<Harness> {
  const infra = opts.infra ?? (await startInfra());
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'debug',
    DATABASE_URL: infra.pg.url,
    REDIS_URL: infra.redis.url,
    GATEWAY_MASTER_KEY: generateDataKey().toString('base64'),
    PUBLIC_URL: 'http://gateway.test',
    NETWORK_ALLOW_PRIVATE: 'true',
    ...s3Env(infra),
    ...opts.env,
  });
  const logs: string[] = [];
  const logger = createLogger(
    config.LOG_LEVEL,
    new Writable({
      write(chunk, _e, cb) {
        logs.push(String(chunk));
        cb();
      },
    }),
  );
  const services = createServices(config, logger, {
    ...(opts.embeddings ? { embeddings: opts.embeddings } : {}),
    ...(opts.spanProcessors ? { spanProcessors: opts.spanProcessors } : {}),
    ...(opts.llm ? { llm: opts.llm } : {}),
  });
  await migrateUp(services.dbHandle.pool);
  await services.start();
  const app = await buildApp(services);
  await app.ready();
  return {
    app,
    services,
    config,
    logs,
    token: (claims, o) => mintToken(services, claims, o),
    /** Tenant admin if the tenant already exists; otherwise a platform admin (uses `X-Tenant`). */
    adminToken: async (tenant = 'dev') => {
      const exists = await services.repos.tenants.findBySlug(tenant);
      return mintToken(services, { sub: 'admin', roles: ['gateway-admin'], azp: 'admin-ui', tenant: exists ? tenant : undefined });
    },
    async teardown() {
      await app.close();
      await services.close();
      if (!opts.infra) await infra.stop();
    },
  };
}
