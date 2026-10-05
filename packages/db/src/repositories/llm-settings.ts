import { decryptJson, encryptJson } from '@mcp-gateway/core';
import { eq } from 'drizzle-orm';
import type { Db } from '../client';
import { tenantLlmSettings } from '../schema';
import type { Keyring } from './keyring';

export type LlmProvider = (typeof tenantLlmSettings.$inferSelect)['provider'];
export type LlmJsonMode = (typeof tenantLlmSettings.$inferSelect)['jsonMode'];

/** Public view of the tenant LLM configuration (ADR-015): never carries the API key. */
export interface LlmSettingsView {
  tenantId: string;
  provider: LlmProvider;
  model: string;
  baseUrl: string | null;
  hasApiKey: boolean;
  /** Last characters of the key, to let the admin recognize which one is configured. */
  apiKeyHint: string | null;
  jsonMode: LlmJsonMode;
  maxGenerationsPerHour: number;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface DecryptedLlmSettings extends LlmSettingsView {
  apiKey: string | null;
}

export interface LlmSettingsPatch {
  provider: LlmProvider;
  model: string;
  baseUrl?: string | null;
  /** `undefined` keeps the current key, `null` removes it, a string replaces it. */
  apiKey?: string | null;
  jsonMode?: LlmJsonMode;
  maxGenerationsPerHour?: number;
}

const aad = (tenantId: string) => `llm-settings:${tenantId}`;

/** Keys too short to hide anything get no hint. */
export function apiKeyHint(apiKey: string): string | null {
  return apiKey.length >= 12 ? apiKey.slice(-4) : null;
}

function view(row: typeof tenantLlmSettings.$inferSelect): LlmSettingsView {
  return {
    tenantId: row.tenantId,
    provider: row.provider,
    model: row.model,
    baseUrl: row.baseUrl,
    hasApiKey: row.apiKeyEncrypted !== null,
    apiKeyHint: row.apiKeyHint,
    jsonMode: row.jsonMode,
    maxGenerationsPerHour: row.maxGenerationsPerHour,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

export class LlmSettingsRepo {
  constructor(
    private readonly db: Db,
    private readonly keyring: Keyring,
  ) {}

  private async row(tenantId: string) {
    const [row] = await this.db.select().from(tenantLlmSettings).where(eq(tenantLlmSettings.tenantId, tenantId));
    return row;
  }

  async get(tenantId: string): Promise<LlmSettingsView | null> {
    const row = await this.row(tenantId);
    return row ? view(row) : null;
  }

  /** Configuration with the plaintext key. For exclusive use by the composer's LLM client. */
  async getDecrypted(tenantId: string): Promise<DecryptedLlmSettings | null> {
    const row = await this.row(tenantId);
    if (!row) return null;
    const apiKey = row.apiKeyEncrypted
      ? decryptJson<{ apiKey: string }>(await this.keyring.dataKey(tenantId), row.apiKeyEncrypted, aad(tenantId)).apiKey
      : null;
    return { ...view(row), apiKey };
  }

  async upsert(tenantId: string, patch: LlmSettingsPatch, by: string): Promise<LlmSettingsView> {
    const set: Partial<typeof tenantLlmSettings.$inferInsert> = {
      provider: patch.provider,
      model: patch.model,
      baseUrl: patch.baseUrl ?? null,
      updatedBy: by,
      updatedAt: new Date(),
    };
    if (patch.jsonMode !== undefined) set.jsonMode = patch.jsonMode;
    if (patch.maxGenerationsPerHour !== undefined) set.maxGenerationsPerHour = patch.maxGenerationsPerHour;
    if (patch.apiKey === null) {
      set.apiKeyEncrypted = null;
      set.apiKeyHint = null;
    } else if (patch.apiKey !== undefined) {
      set.apiKeyEncrypted = encryptJson(await this.keyring.dataKey(tenantId), { apiKey: patch.apiKey }, aad(tenantId));
      set.apiKeyHint = apiKeyHint(patch.apiKey);
    }
    const [row] = await this.db
      .insert(tenantLlmSettings)
      .values({ ...set, tenantId, provider: patch.provider, model: patch.model })
      .onConflictDoUpdate({ target: tenantLlmSettings.tenantId, set })
      .returning();
    return view(row!);
  }

  async delete(tenantId: string): Promise<void> {
    await this.db.delete(tenantLlmSettings).where(eq(tenantLlmSettings.tenantId, tenantId));
  }
}
