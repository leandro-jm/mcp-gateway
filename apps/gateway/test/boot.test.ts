import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));

describe('gateway boot', () => {
  it('fails with a clear message when a required env var is missing', () => {
    const res = spawnSync(process.execPath, ['--import', 'tsx', main], {
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('boot failed');
    for (const key of ['DATABASE_URL', 'REDIS_URL', 'GATEWAY_MASTER_KEY']) {
      expect(res.stderr).toContain(`${key}: required variable is missing`);
    }
  });
});
