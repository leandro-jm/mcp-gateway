import { describe, expect, it } from 'vitest';
import { LOG_REDACT_PATHS, scrubSensitive } from './sensitive';

describe('scrubSensitive', () => {
  it('removes values of sensitive keys at any level', () => {
    const out = scrubSensitive({
      headers: { Authorization: 'Bearer abc', 'x-api-key': 'k' },
      body: [{ password: 'p', nome: 'ok' }],
    });
    expect(out).toEqual({
      headers: { Authorization: '[REDACTED]', 'x-api-key': '[REDACTED]' },
      body: [{ password: '[REDACTED]', nome: 'ok' }],
    });
  });

  it('generates redact paths for pino', () => {
    expect(LOG_REDACT_PATHS).toContain('req.headers.authorization');
    expect(LOG_REDACT_PATHS).toContain('req.headers["x-api-key"]');
  });
});
