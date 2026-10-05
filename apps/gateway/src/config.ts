import { assertProductionConfig, base64Key32, envBool, envInt, parseEnv } from '@mcp-gateway/core';
import { z } from 'zod';

export const gatewayConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: envInt(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PUBLIC_URL: z.url().default('http://localhost:4000'),

  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),

  /** Envelope encryption master key (32 bytes, base64). */
  GATEWAY_MASTER_KEY: base64Key32,

  /** Lifetime of session tokens issued by the Admin UI login (ADR-011). */
  AUTH_SESSION_TTL_HOURS: envInt(12),
  /** Login attempts per username + IP every 5 minutes. */
  AUTH_LOGIN_RATE_LIMIT: envInt(10),
  /** Login attempts per username every 15 minutes, whatever the IP (distributed brute force). */
  AUTH_LOGIN_USER_RATE_LIMIT: envInt(30),

  /**
   * Proxies trusted for `X-Forwarded-For` (Fastify `trustProxy`): `false` (default), a hop count
   * or a comma-separated list of IPs/CIDRs. Trusting every hop lets clients choose their own IP.
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v): boolean | number | string => (v === 'false' || v === '' ? false : /^\d+$/.test(v) ? Number(v) : v === 'true' ? true : v)),

  /** Optional embeddings for tool search (API compatible with POST /embeddings). */
  EMBEDDINGS_URL: z.url().optional(),
  EMBEDDINGS_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDINGS_API_KEY: z.string().optional(),

  /** OpenTelemetry traces (OTLP/HTTP). Without an endpoint, spans are not exported. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  /** Link from the call explorer to the trace UI (e.g. `http://jaeger:16686/trace/{traceId}`). */
  TRACE_UI_URL_TEMPLATE: z.string().optional(),
  /** Protects `/metrics` with a static Bearer (optional). */
  METRICS_TOKEN: z.string().optional(),

  /** SSRF (F11.1): allow upstreams on private/loopback networks. Production: false. */
  NETWORK_ALLOW_PRIVATE: envBool(false),

  /** Source import (ADR-014): request body limit of the import routes and download limits of URL inputs. */
  IMPORT_MAX_BYTES: envInt(10 * 1024 * 1024),
  IMPORT_FETCH_TIMEOUT_MS: envInt(15_000),

  /** Audit retention (older monthly partitions are dropped). */
  AUDIT_RETENTION_MONTHS: envInt(12),

  /** Call events (F15, ADR-016): raw retention (daily partitions) and batched writer. */
  CALL_EVENTS_RETENTION_DAYS: envInt(30),
  CALL_EVENTS_FLUSH_MS: envInt(1000),
  CALL_EVENTS_BATCH_SIZE: envInt(500),
  CALL_EVENTS_BUFFER_MAX: envInt(20_000),
  /** Hourly/daily rollups (F15.8): the dashboards' source, kept much longer than raw events. */
  CALL_ROLLUPS_RETENTION_DAYS: envInt(400),
  /** Debug capture (F15.17, ADR-017): off unless enabled; captures last minutes and items hours. */
  DEBUG_CAPTURE_ENABLED: envBool(false),
  DEBUG_CAPTURE_MAX_MINUTES: envInt(60),
  DEBUG_CAPTURE_RETENTION_HOURS: envInt(24),
  /** LGPD subject index (F15.11, ADR-017): monthly partitions kept this long. */
  SUBJECT_INDEX_RETENTION_MONTHS: envInt(12),

  /** Artifacts (F8). Without S3 configured, offloading is off (ADR-010). */
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_BUCKET: z.string().optional(),
});

export type GatewayConfig = z.output<typeof gatewayConfigSchema>;

export function loadConfig(env: Record<string, string | undefined>): GatewayConfig {
  const config = parseEnv(gatewayConfigSchema, env);
  assertProductionConfig(config, { requireMetricsToken: true });
  return config;
}
