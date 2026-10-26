import { decryptJson, encryptJson } from '@mcp-gateway/core';
import { eq } from 'drizzle-orm';
import type { Db } from '../client';
import { tenantDecisionSettings } from '../schema';
import type { Keyring } from './keyring';
import { apiKeyHint } from './llm-settings';

export type DecisionProviderName = (typeof tenantDecisionSettings.$inferSelect)['provider'];

/** Public view of the tool router's decision provider (ADR-025): never carries the API key. */
export interface DecisionSettingsView {
  tenantId: string;
  provider: DecisionProviderName;
  model: string;
  baseUrl: string | null;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface DecryptedDecisionSettings extends DecisionSettingsView {
  apiKey: string | null;
}

export interface DecisionSettingsPatch {
  provider: DecisionProviderName;
  model: string;
  baseUrl?: string | null;
  /** `undefined` keeps the current key, `null` removes it, a string replaces it. */
  apiKey?: string | null;
}

const aad = (tenantId: string) => `decision-settings:${tenantId}`;

function view(row: typeof tenantDecisionSettings.$inferSelect): DecisionSettingsView {
  return {
    tenantId: row.tenantId,
    provider: row.provider,
    model: row.model,
    baseUrl: row.baseUrl,
    hasApiKey: row.apiKeyEncrypted !== null,
    apiKeyHint: row.apiKeyHint,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

export class DecisionSettingsRepo {
  constructor(
    private readonly db: Db,
    private readonly keyring: Keyring,
  ) {}

  private async row(tenantId: string) {
    const [row] = await this.db.select().from(tenantDecisionSettings).where(eq(tenantDecisionSettings.tenantId, tenantId));
    return row;
  }

  async get(tenantId: string): Promise<DecisionSettingsView | null> {
    const row = await this.row(tenantId);
    return row ? view(row) : null;
  }

  /** Configuration with the plaintext key. For exclusive use by the tool router's provider client. */
  async getDecrypted(tenantId: string): Promise<DecryptedDecisionSettings | null> {
    const row = await this.row(tenantId);
    if (!row) return null;
    const apiKey = row.apiKeyEncrypted
      ? decryptJson<{ apiKey: string }>(await this.keyring.dataKey(tenantId), row.apiKeyEncrypted, aad(tenantId)).apiKey
      : null;
    return { ...view(row), apiKey };
  }

  async upsert(tenantId: string, patch: DecisionSettingsPatch, by: string): Promise<DecisionSettingsView> {
    const set: Partial<typeof tenantDecisionSettings.$inferInsert> = {
      provider: patch.provider,
      model: patch.model,
      baseUrl: patch.baseUrl ?? null,
      updatedBy: by,
      updatedAt: new Date(),
    };
    if (patch.apiKey === null) {
      set.apiKeyEncrypted = null;
      set.apiKeyHint = null;
    } else if (patch.apiKey !== undefined) {
      set.apiKeyEncrypted = encryptJson(await this.keyring.dataKey(tenantId), { apiKey: patch.apiKey }, aad(tenantId));
      set.apiKeyHint = apiKeyHint(patch.apiKey);
    }
    const [row] = await this.db
      .insert(tenantDecisionSettings)
      .values({ ...set, tenantId, provider: patch.provider, model: patch.model })
      .onConflictDoUpdate({ target: tenantDecisionSettings.tenantId, set })
      .returning();
    return view(row!);
  }

  async delete(tenantId: string): Promise<void> {
    await this.db.delete(tenantDecisionSettings).where(eq(tenantDecisionSettings.tenantId, tenantId));
  }
}
