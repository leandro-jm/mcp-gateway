import { randomUUID } from 'node:crypto';
import {
  Conflict,
  credentialConfigSchemas,
  decryptJson,
  describeCredentialConfig,
  encryptJson,
  NotFound,
  ValidationError,
  type CredentialConfig,
  type CredentialType,
} from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { credentials, upstreamSources } from '../schema';
import type { Keyring } from './keyring';

export interface CredentialView {
  id: string;
  tenantId: string;
  name: string;
  type: CredentialType;
  /** Non-secret fields only. */
  config: Record<string, unknown>;
  rotatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DecryptedCredential {
  id: string;
  type: CredentialType;
  config: CredentialConfig;
  /** Changes on every rotation (used to invalidate cached tokens). */
  version: number;
}

const aad = (tenantId: string, id: string) => `credential:${tenantId}:${id}`;

function parseConfig(type: CredentialType, config: unknown): CredentialConfig {
  const r = credentialConfigSchemas[type].safeParse(config);
  if (!r.success) {
    throw new ValidationError(msg('db.credentialInvalidConfig', { type }), r.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    })));
  }
  return r.data;
}

export class CredentialsRepo {
  constructor(
    private readonly db: Db,
    private readonly keyring: Keyring,
  ) {}

  private async view(tenantId: string, row: typeof credentials.$inferSelect): Promise<CredentialView> {
    const key = await this.keyring.dataKey(tenantId);
    const config = decryptJson<Record<string, unknown>>(key, row.configEncrypted, aad(tenantId, row.id));
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      type: row.type,
      config: describeCredentialConfig(row.type, config),
      rotatedAt: row.rotatedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async create(
    tenantId: string,
    input: { name: string; type: CredentialType; config: unknown },
  ): Promise<CredentialView> {
    const config = parseConfig(input.type, input.config);
    const id = randomUUID();
    const key = await this.keyring.dataKey(tenantId);
    const [row] = await this.db
      .insert(credentials)
      .values({ id, tenantId, name: input.name, type: input.type, configEncrypted: encryptJson(key, config, aad(tenantId, id)) })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new Conflict(msg('db.credentialExists', { name: input.name }));
    return this.view(tenantId, row);
  }

  async list(tenantId: string): Promise<CredentialView[]> {
    const rows = await this.db
      .select()
      .from(credentials)
      .where(eq(credentials.tenantId, tenantId))
      .orderBy(asc(credentials.name));
    return Promise.all(rows.map((r) => this.view(tenantId, r)));
  }

  private async row(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.tenantId, tenantId), eq(credentials.id, id)));
    if (!row) throw new NotFound('credential', id);
    return row;
  }

  async get(tenantId: string, id: string): Promise<CredentialView> {
    return this.view(tenantId, await this.row(tenantId, id));
  }

  /** Plaintext configuration. For exclusive use by the data plane's credential manager. */
  async getDecrypted(tenantId: string, id: string): Promise<DecryptedCredential> {
    const row = await this.row(tenantId, id);
    const key = await this.keyring.dataKey(tenantId);
    return {
      id: row.id,
      type: row.type,
      config: decryptJson<CredentialConfig>(key, row.configEncrypted, aad(tenantId, id)),
      version: (row.rotatedAt ?? row.createdAt).getTime(),
    };
  }

  /**
   * Updates name and/or configuration. When `config` is given, it replaces the whole
   * configuration (rotation) and updates `rotated_at`.
   */
  async update(tenantId: string, id: string, patch: { name?: string; config?: unknown }): Promise<CredentialView> {
    const current = await this.row(tenantId, id);
    const set: Partial<typeof credentials.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.config !== undefined) {
      const config = parseConfig(current.type, patch.config);
      const key = await this.keyring.dataKey(tenantId);
      set.configEncrypted = encryptJson(key, config, aad(tenantId, id));
      set.rotatedAt = new Date();
    }
    const [row] = await this.db
      .update(credentials)
      .set(set)
      .where(and(eq(credentials.tenantId, tenantId), eq(credentials.id, id)))
      .returning();
    return this.view(tenantId, row!);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await this.row(tenantId, id);
    const [inUse] = await this.db
      .select({ id: upstreamSources.id })
      .from(upstreamSources)
      .where(and(eq(upstreamSources.tenantId, tenantId), eq(upstreamSources.credentialId, id)))
      .limit(1);
    if (inUse) throw new Conflict(msg('db.credentialInUse'), { sourceId: inUse.id });
    await this.db.delete(credentials).where(and(eq(credentials.tenantId, tenantId), eq(credentials.id, id)));
  }
}
