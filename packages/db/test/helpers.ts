import { generateDataKey } from '@mcp-gateway/core';
import { startPostgres, type StartedPostgres } from '@mcp-gateway/testkit';
import { createDb, migrateUp, type DbHandle } from '../src';

export interface TestDb extends DbHandle {
  pg: StartedPostgres;
  masterKey: Buffer;
  teardown(): Promise<void>;
}

export async function setupTestDb(): Promise<TestDb> {
  const pg = await startPostgres();
  const handle = createDb(pg.url);
  await migrateUp(handle.pool);
  return {
    ...handle,
    pg,
    masterKey: generateDataKey(),
    async teardown() {
      await handle.close();
      await pg.stop();
    },
  };
}
