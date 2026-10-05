import { startMinio, type StartedMinio } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../src';

describe('ArtifactStore (MinIO)', () => {
  let minio: StartedMinio;
  let store: ArtifactStore;
  beforeAll(async () => {
    minio = await startMinio();
    store = new ArtifactStore({ endpoint: minio.endpoint, accessKeyId: minio.accessKey, secretAccessKey: minio.secretKey, bucket: 'artifacts' });
    await store.ensureBucket();
    await store.ensureBucket(); // idempotent
  });
  afterAll(async () => {
    store?.close();
    await minio?.stop();
  });

  it('writes, reads and deletes', async () => {
    const key = ArtifactStore.key('t1', 's1', 'c1');
    expect(key).toBe('t1/s1/c1.json');
    await store.put(key, JSON.stringify({ a: 1 }));
    expect(JSON.parse(await store.getText(key))).toEqual({ a: 1 });
    await expect(store.getText(key, 2)).rejects.toThrow(/exceeds/);
    await store.deleteMany([key]);
    await expect(store.getText(key)).rejects.toThrow();
  });
});
