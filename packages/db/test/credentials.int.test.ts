import { ValidationError } from '@mcp-gateway/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CredentialsRepo, Keyring, tenants } from '../src';
import { setupTestDb, type TestDb } from './helpers';

const SECRETS = ['s3cr3t-client-secret-xyz', 'p4ssw0rd-of-the-user', 'super-secret-api-key'];

describe('encrypted credentials', () => {
  let t: TestDb;
  let repo: CredentialsRepo;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    t = await setupTestDb();
    const rows = await t.db
      .insert(tenants)
      .values([
        { slug: 'a', name: 'A' },
        { slug: 'b', name: 'B' },
      ])
      .returning();
    tenantA = rows[0]!.id;
    tenantB = rows[1]!.id;
    repo = new CredentialsRepo(t.db, new Keyring(t.db, t.masterKey));
  });
  afterAll(async () => t?.teardown());

  it('never stores a plaintext secret in the database nor returns it in the public view', async () => {
    const cc = await repo.create(tenantA, {
      name: 'rh-oauth',
      type: 'oauth2_client_credentials',
      config: { tokenUrl: 'http://x/token', clientId: 'gw', clientSecret: SECRETS[0] },
    });
    await repo.create(tenantA, {
      name: 'rh-pwd',
      type: 'oauth2_password',
      config: { tokenUrl: 'http://x/token', clientId: 'gw', username: 'u', password: SECRETS[1] },
    });
    await repo.create(tenantA, { name: 'rh-key', type: 'api_key', config: { name: 'X-API-Key', value: SECRETS[2] } });

    expect(cc.config).toEqual({ tokenUrl: 'http://x/token', clientId: 'gw', authMethod: 'body' });

    const dump = JSON.stringify((await t.pool.query('SELECT * FROM credentials')).rows);
    const tenantsDump = JSON.stringify((await t.pool.query('SELECT * FROM tenants')).rows);
    const listed = JSON.stringify(await repo.list(tenantA));
    for (const s of SECRETS) {
      expect(dump).not.toContain(s);
      expect(listed).not.toContain(s);
    }
    // The data key is encrypted with the master key; the master key does not appear in the database.
    expect(tenantsDump).not.toContain(t.masterKey.toString('base64'));
    expect(tenantsDump).toContain('v1.');
  });

  it('decrypts for internal use and rotates', async () => {
    const [c] = (await repo.list(tenantA)).filter((x) => x.name === 'rh-key');
    const dec = await repo.getDecrypted(tenantA, c!.id);
    expect(dec.config).toMatchObject({ value: SECRETS[2], in: 'header' });
    const rotated = await repo.update(tenantA, c!.id, { config: { name: 'X-API-Key', value: 'new-key' } });
    expect(rotated.rotatedAt).toBeInstanceOf(Date);
    expect((await repo.getDecrypted(tenantA, c!.id)).config).toMatchObject({ value: 'new-key' });
  });

  it('isolates tenants (another tenant cannot read, and a swapped ciphertext does not decrypt)', async () => {
    const [c] = await repo.list(tenantA);
    await expect(repo.get(tenantB, c!.id)).rejects.toThrow(/credential not found/);
    // Copying the ciphertext to tenant B does not work (different data key and AAD).
    const created = await repo.create(tenantB, { name: 'b', type: 'bearer_static', config: { token: 'tb' } });
    await t.pool.query('UPDATE credentials SET config_encrypted = (SELECT config_encrypted FROM credentials WHERE id = $1) WHERE id = $2', [
      c!.id,
      created.id,
    ]);
    await expect(repo.getDecrypted(tenantB, created.id)).rejects.toThrow();
  });

  it('rejects an invalid configuration', async () => {
    const err = await repo.create(tenantA, { name: 'x', type: 'basic', config: { username: 'u' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).toBe('invalid configuration for credential basic');
    expect((err as ValidationError).localize('pt-BR')).toBe('configuração inválida para credencial basic');
  });
});
