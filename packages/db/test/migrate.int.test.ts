import { startPostgres, type StartedPostgres } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken, verifyPassword } from '@mcp-gateway/core';
import { AuthQueries, createDb, migrateDown, migrateUp, seedDev, type DbHandle } from '../src';

async function tables(h: DbHandle): Promise<string[]> {
  const { rows } = await h.pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY 1",
  );
  return rows.map((r) => r.tablename);
}

describe('migrations', () => {
  let pg: StartedPostgres;
  let h: DbHandle;

  beforeAll(async () => {
    pg = await startPostgres();
    h = createDb(pg.url);
  });
  afterAll(async () => {
    await h?.close();
    await pg?.stop();
  });

  it('go up, down and up again', async () => {
    const ran = await migrateUp(h.pool);
    expect(ran.length).toBeGreaterThan(0);
    expect(await tables(h)).toEqual(
      expect.arrayContaining(['tenants', 'upstream_sources', 'credentials', 'tools', 'tool_versions', 'policies', 'users', 'api_tokens']),
    );
    expect(await migrateUp(h.pool)).toEqual([]);

    const reverted = await migrateDown(h.pool, Infinity);
    expect(reverted).toEqual([...ran].reverse());
    expect(await tables(h)).toEqual([]);
    const { rows } = await h.pool.query("SELECT 1 FROM pg_type WHERE typname = 'tool_state'");
    expect(rows).toHaveLength(0);

    expect(await migrateUp(h.pool)).toEqual(ran);
  });

  it('dev seed creates 1 tenant and 1 source pointing to the fake upstream (idempotent)', async () => {
    const a = await seedDev(h.db, { upstreamUrl: 'http://127.0.0.1:4010/' });
    const b = await seedDev(h.db, { upstreamUrl: 'http://127.0.0.1:4010/' });
    expect(b).toEqual(a);
    const t = await h.pool.query('SELECT slug FROM tenants');
    const s = await h.pool.query('SELECT name, base_url, openapi_url FROM upstream_sources');
    expect(t.rows).toEqual([{ slug: 'dev' }]);
    expect(s.rows).toEqual([
      { name: 'rh', base_url: 'http://127.0.0.1:4010', openapi_url: 'http://127.0.0.1:4010/openapi.json' },
    ]);
  });

  it('dev seed creates the users and the agent-dev token (idempotent)', async () => {
    const auth = new AuthQueries(h.db);
    const admin = await auth.findLogin('admin');
    expect(admin?.tenant).toBeNull();
    expect(admin?.user.roles).toEqual(['gateway-admin']);
    expect(await verifyPassword('admin', admin!.passwordHash!)).toBe(true);
    const owner = await auth.findLogin('owner');
    expect(owner).toMatchObject({ tenant: { slug: 'dev' }, user: { roles: ['tool-owner'], groups: ['team-rh'], locale: 'en' } });
    expect((await auth.findLogin('owner-pt'))?.user.locale).toBe('pt-BR');
    expect((await auth.findLogin('owner-es'))?.user.locale).toBe('es');
    const { agentToken } = await seedDev(h.db);
    const rec = await auth.findToken(hashToken(agentToken));
    expect(rec).toMatchObject({ user: { username: 'agent-dev', kind: 'service', hasPassword: false }, token: { name: 'agent-dev' } });
    const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM users');
    expect(rows[0].n).toBe(6);
  });

  it('a user without a tenant requires the gateway-admin role', async () => {
    await expect(new AuthQueries(h.db).createUser(null, { username: 'no-tenant', roles: ['agent'] })).rejects.toThrow();
  });
});
