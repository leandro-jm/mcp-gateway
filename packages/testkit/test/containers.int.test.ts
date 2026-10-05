import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { startMinio, startPostgres, startRedis } from '../src';

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port }, () => {
      s.end();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });
}

describe('testcontainers helpers', () => {
  it('starts Postgres, Redis and MinIO', async () => {
    const [pg, redis, minio] = await Promise.all([startPostgres(), startRedis(), startMinio()]);
    try {
      for (const u of [pg.url, redis.url, minio.endpoint]) {
        const parsed = new URL(u);
        expect(await reachable(parsed.hostname, Number(parsed.port))).toBe(true);
      }
      const res = await fetch(`${minio.endpoint}/minio/health/live`);
      expect(res.status).toBe(200);
    } finally {
      await Promise.all([pg.stop(), redis.stop(), minio.stop()]);
    }
  });
});
