import { ConfigError, DEV_MASTER_KEY } from '@mcp-gateway/core';
import { LOCALES } from '@mcp-gateway/i18n';
import { serverCatalog } from '@mcp-gateway/i18n/server';
import { OAUTH_ERROR_REASONS } from '@mcp-gateway/oauth';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  GATEWAY_MASTER_KEY: DEV_MASTER_KEY,
};
const production = {
  ...base,
  NODE_ENV: 'production',
  GATEWAY_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  METRICS_TOKEN: 'metrics-token',
};

describe('oauth config (F20.4)', () => {
  it('is off by default with the documented lifetimes', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      OAUTH_ENABLED: false,
      OAUTH_DCR_ENABLED: true,
      OAUTH_ACCESS_TTL_MINUTES: 60,
      OAUTH_REFRESH_TTL_DAYS: 30,
      OAUTH_CODE_TTL_SECONDS: 60,
    });
  });

  it('refuses OAuth over plain HTTP in production', () => {
    expect(() => loadConfig({ ...production, OAUTH_ENABLED: 'true', PUBLIC_URL: 'http://mcp.example.com' })).toThrow(ConfigError);
    expect(loadConfig({ ...production, OAUTH_ENABLED: 'true', PUBLIC_URL: 'https://mcp.example.com' }).OAUTH_ENABLED).toBe(true);
    expect(loadConfig({ ...production, PUBLIC_URL: 'http://mcp.example.com' }).OAUTH_ENABLED).toBe(false);
  });

  it('refuses a PUBLIC_URL with query or fragment as issuer', () => {
    expect(() => loadConfig({ ...base, OAUTH_ENABLED: 'true', PUBLIC_URL: 'http://localhost:4000/?x=1' })).toThrow(ConfigError);
    expect(loadConfig({ ...base, OAUTH_ENABLED: 'true', PUBLIC_URL: 'http://localhost:4000' }).OAUTH_ENABLED).toBe(true);
  });

  it('bounds the lifetimes', () => {
    expect(() => loadConfig({ ...base, OAUTH_ACCESS_TTL_MINUTES: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, OAUTH_REFRESH_TTL_DAYS: '400' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, OAUTH_CODE_TTL_SECONDS: '3600' })).toThrow(ConfigError);
  });
});

describe('oauth messages (F20.4)', () => {
  it('describes every error reason in every locale', () => {
    for (const locale of LOCALES) {
      const missing = OAUTH_ERROR_REASONS.filter((reason) => !serverCatalog[locale][`oauth.reason.${reason}`]);
      expect(missing, locale).toEqual([]);
    }
  });
});
