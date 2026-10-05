import { describe, expect, it } from 'vitest';
import { readTrafficSettings, readWebhooks } from './tenant-settings';

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
