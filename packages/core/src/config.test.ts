import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assertProductionConfig, base64Key32, ConfigError, DEV_MASTER_KEY, envBool, envInt, parseEnv } from './config';

const schema = z.object({
  DATABASE_URL: z.url(),
  PORT: envInt(4000),
  DEBUG: envBool(false),
  KEY: base64Key32,
});

const KEY = Buffer.alloc(32, 1).toString('base64');

describe('parseEnv', () => {
  it('applies defaults and coercions', () => {
    const cfg = parseEnv(schema, { DATABASE_URL: 'postgres://x/y', KEY, DEBUG: '1' });
    expect(cfg).toEqual({ DATABASE_URL: 'postgres://x/y', PORT: 4000, DEBUG: true, KEY });
  });

  it('treats an empty variable as missing (default or optional)', () => {
    const s = z.object({ OPT: z.url().optional(), PORT: envInt(4000) });
    expect(parseEnv(s, { OPT: '', PORT: ' ' })).toEqual({ PORT: 4000 });
  });

  it('lists every missing or invalid variable in a clear message', () => {
    try {
      parseEnv(schema, { PORT: 'abc', KEY: 'short' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).message;
      expect(msg).toContain('DATABASE_URL: required variable is missing');
      expect(msg).toContain('PORT:');
      expect(msg).toContain('KEY: must be a 32-byte base64 key');
    }
  });
});

describe('assertProductionConfig', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  it('refuses the dev master key and a missing metrics token in production only', () => {
    expect(() => assertProductionConfig({ NODE_ENV: 'production', GATEWAY_MASTER_KEY: DEV_MASTER_KEY, METRICS_TOKEN: 'x' })).toThrow(/development key/);
    expect(() => assertProductionConfig({ NODE_ENV: 'production', GATEWAY_MASTER_KEY: key }, { requireMetricsToken: true })).toThrow(/METRICS_TOKEN/);
    expect(() => assertProductionConfig({ NODE_ENV: 'production', GATEWAY_MASTER_KEY: key, METRICS_TOKEN: 'x' }, { requireMetricsToken: true })).not.toThrow();
    expect(() => assertProductionConfig({ NODE_ENV: 'development', GATEWAY_MASTER_KEY: DEV_MASTER_KEY }, { requireMetricsToken: true })).not.toThrow();
  });
});
