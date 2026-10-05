import { z } from 'zod';

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validates environment variables against a Zod schema. Takes `env` explicitly
 * (the package is pure); the app passes `process.env`.
 */
export function parseEnv<S extends z.ZodType>(schema: S, rawEnv: Record<string, string | undefined>): z.output<S> {
  // Empty variable = missing (compose/Portainer often pass `VAR=` for optional ones).
  const env = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    const missing = issue.code === 'invalid_type' && env[key] === undefined;
    return missing ? `${key}: required variable is missing` : `${key}: ${issue.message}`;
  });
  throw new ConfigError(issues);
}

/** Master key published in the dev `.env.example`: anyone can decrypt with it. */
export const DEV_MASTER_KEY = 'ZGV2LW1hc3Rlci1rZXktMzItYnl0ZXMtLS0tLS0tLS0=';

/** Refuses to start in production with settings that are only acceptable in development. */
export function assertProductionConfig(
  cfg: { NODE_ENV: string; GATEWAY_MASTER_KEY: string; METRICS_TOKEN?: string | undefined },
  opts: { requireMetricsToken?: boolean } = {},
): void {
  if (cfg.NODE_ENV !== 'production') return;
  const issues: string[] = [];
  if (cfg.GATEWAY_MASTER_KEY === DEV_MASTER_KEY) issues.push('GATEWAY_MASTER_KEY: the development key cannot be used in production');
  if (opts.requireMetricsToken && !cfg.METRICS_TOKEN) issues.push('METRICS_TOKEN: required in production (/metrics exposes tenant, source and tool names)');
  if (issues.length) throw new ConfigError(issues);
}

/** Schema helpers for env. */
export const envBool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

export const envInt = (def?: number) => {
  const base = z.coerce.number().int();
  return def === undefined ? base : base.default(def);
};

/** 32-byte key encoded in base64. */
export const base64Key32 = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be a 32-byte base64 key');
