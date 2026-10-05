import { decryptJson } from '@mcp-gateway/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keyring, LlmSettingsRepo, tenants } from '../src';
import { setupTestDb, type TestDb } from './helpers';

const KEY = 'sk-ant-api03-super-secret-llm-key-9f3a';

describe('tenant LLM settings', () => {
  let t: TestDb;
  let keyring: Keyring;
  let repo: LlmSettingsRepo;
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
    repo = new LlmSettingsRepo(t.db, keyring);
  });
  afterAll(async () => t?.teardown());

  it('returns null when the tenant has no configuration', async () => {
    expect(await repo.get(tenantA)).toBeNull();
    expect(await repo.getDecrypted(tenantA)).toBeNull();
  });

  it('never stores the key in clear nor returns it in the public view', async () => {
    const saved = await repo.upsert(tenantA, { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: KEY }, 'admin');
    expect(saved).toMatchObject({ provider: 'anthropic', hasApiKey: true, apiKeyHint: '9f3a', updatedBy: 'admin' });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    expect(JSON.stringify(await repo.get(tenantA))).not.toContain(KEY);
    const dump = JSON.stringify((await t.pool.query('SELECT * FROM tenant_llm_settings')).rows);
    expect(dump).not.toContain(KEY);
    expect((await repo.getDecrypted(tenantA))?.apiKey).toBe(KEY);
  });

  it('binds the ciphertext to the tenant (aad)', async () => {
    const {
      rows: [row],
    } = await t.pool.query('SELECT api_key_encrypted FROM tenant_llm_settings WHERE tenant_id = $1', [tenantA]);
    const keyB = await keyring.dataKey(tenantB);
    const keyA = await keyring.dataKey(tenantA);
    expect(() => decryptJson(keyA, row.api_key_encrypted, `llm-settings:${tenantB}`)).toThrow();
    expect(() => decryptJson(keyB, row.api_key_encrypted, `llm-settings:${tenantA}`)).toThrow();
  });

  it('keeps the key when omitted, removes it with null and isolates tenants', async () => {
    const kept = await repo.upsert(tenantA, { provider: 'openai', model: 'gpt-x', maxGenerationsPerHour: 5 }, 'admin');
    expect(kept).toMatchObject({ provider: 'openai', hasApiKey: true, maxGenerationsPerHour: 5 });
    expect(await repo.get(tenantB)).toBeNull();

    const removed = await repo.upsert(tenantA, { provider: 'openai', model: 'gpt-x', apiKey: null }, 'admin');
    expect(removed).toMatchObject({ hasApiKey: false, apiKeyHint: null });
    expect((await repo.getDecrypted(tenantA))?.apiKey).toBeNull();

    await repo.delete(tenantA);
    expect(await repo.get(tenantA)).toBeNull();
  });
});
