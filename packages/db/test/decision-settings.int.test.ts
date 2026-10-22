import { decryptJson } from '@mcp-gateway/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DecisionSettingsRepo, Keyring, tenants } from '../src';
import { setupTestDb, type TestDb } from './helpers';

const KEY = 'sk-proj-super-secret-decisions-key-7c1e';

describe('tenant decision settings (F19.3)', () => {
  let t: TestDb;
  let keyring: Keyring;
  let repo: DecisionSettingsRepo;
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
    keyring = new Keyring(t.db, t.masterKey);
    repo = new DecisionSettingsRepo(t.db, keyring);
  });
  afterAll(async () => t?.teardown());

  it('returns null when the tenant has no provider', async () => {
    expect(await repo.get(tenantA)).toBeNull();
    expect(await repo.getDecrypted(tenantA)).toBeNull();
  });

  it('never stores the key in clear nor returns it in the public view', async () => {
    const saved = await repo.upsert(tenantA, { provider: 'openai_decisions', model: 'gpt-6-luna', apiKey: KEY }, 'admin');
    expect(saved).toMatchObject({ provider: 'openai_decisions', hasApiKey: true, apiKeyHint: '7c1e', updatedBy: 'admin' });
    expect(JSON.stringify(await repo.get(tenantA))).not.toContain(KEY);
    const dump = JSON.stringify((await t.pool.query('SELECT * FROM tenant_decision_settings')).rows);
    expect(dump).not.toContain(KEY);
    expect((await repo.getDecrypted(tenantA))?.apiKey).toBe(KEY);
  });

  it('binds the ciphertext to the tenant and to this table (aad)', async () => {
    const {
      rows: [row],
    } = await t.pool.query('SELECT api_key_encrypted FROM tenant_decision_settings WHERE tenant_id = $1', [tenantA]);
    const keyA = await keyring.dataKey(tenantA);
    expect(() => decryptJson(keyA, row.api_key_encrypted, `decision-settings:${tenantB}`)).toThrow();
    expect(() => decryptJson(keyA, row.api_key_encrypted, `llm-settings:${tenantA}`)).toThrow();
  });

  it('keeps the key when omitted, removes it with null and isolates tenants', async () => {
    const kept = await repo.upsert(tenantA, { provider: 'jev', model: 'jev-latest', baseUrl: 'https://proxy.example/v1' }, 'admin');
    expect(kept).toMatchObject({ provider: 'jev', hasApiKey: true, baseUrl: 'https://proxy.example/v1' });
    expect(await repo.get(tenantB)).toBeNull();

    const removed = await repo.upsert(tenantA, { provider: 'jev', model: 'jev-latest', apiKey: null }, 'admin');
    expect(removed).toMatchObject({ hasApiKey: false, apiKeyHint: null, baseUrl: null });

    await repo.delete(tenantA);
    expect(await repo.get(tenantA)).toBeNull();
  });
});
