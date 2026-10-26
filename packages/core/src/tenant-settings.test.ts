import { describe, expect, it } from 'vitest';
import { readToolRouterSettings, readTrafficSettings, readWebhooks } from './tenant-settings';

describe('tenant settings', () => {
  it('applies traffic defaults', () => {
    const s = readTrafficSettings({});
    expect(s.rateLimits.perClient).toEqual({ limit: 600, windowSec: 60 });
    expect(s.limits.maxResponseBytes).toBe(10 * 1024 * 1024);
    expect(s.circuitBreaker.failureThreshold).toBe(5);
  });
  it('reads partial settings and allows disabling a limit with null', () => {
    const s = readTrafficSettings({ rateLimits: { perTenant: null, tools: { rh_x: { limit: 2 } } }, limits: { maxRequestBytes: 10 } });
    expect(s.rateLimits.perTenant).toBeNull();
    expect(s.rateLimits.tools.rh_x).toEqual({ limit: 2, windowSec: 60 });
    expect(s.limits).toEqual({ maxRequestBytes: 10, maxResponseBytes: 10 * 1024 * 1024 });
  });
  it('ignores invalid settings', () => {
    expect(readTrafficSettings({ limits: { maxRequestBytes: -1 } }).limits.maxRequestBytes).toBe(1024 * 1024);
    expect(readWebhooks({ webhooks: [{ id: 'a', url: 'not-a-url' }, { id: 'b', url: 'http://x/h' }] }).map((w) => w.id)).toEqual(['b']);
  });
});

describe('tool router settings (F19.3)', () => {
  it('is off by default, with rerank as the only point on once enabled', () => {
    const s = readToolRouterSettings({});
    expect(s.enabled).toBe(false);
    expect([s.rerank.enabled, s.shortlist.enabled, s.gate.enabled]).toEqual([true, false, false]);
    expect(s.gate).toMatchObject({ scope: 'non-readonly', argsMode: 'redacted', onError: 'allow', onConfirmWithoutUi: 'deny' });
  });

  it('fills nested defaults around partial input', () => {
    const s = readToolRouterSettings({ toolRouter: { enabled: true, gate: { enabled: true, denyAt: 0.95 } } });
    expect(s.enabled).toBe(true);
    expect(s.gate).toMatchObject({ enabled: true, denyAt: 0.95, confirmAt: 0.5 });
    expect(s.shortlist.maxTools).toBe(30);
  });

  it('reads invalid settings as the defaults, which keep the router off', () => {
    expect(readToolRouterSettings({ toolRouter: { enabled: true, gate: { confirmAt: 0.95, denyAt: 0.5 } } }).enabled).toBe(false);
    expect(readToolRouterSettings({ toolRouter: { enabled: 'yes' } }).enabled).toBe(false);
    expect(readToolRouterSettings(null).enabled).toBe(false);
  });
});
