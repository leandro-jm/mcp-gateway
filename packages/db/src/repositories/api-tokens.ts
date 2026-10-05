import { NotFound } from '@mcp-gateway/core';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from '../client';
import { apiTokens, users } from '../schema';

/** Token without the hash (safe for listings). */
export type ApiToken = Omit<typeof apiTokens.$inferSelect, 'tokenHash'>;

export interface ApiTokenInput {
  name: string;
  kind?: ApiToken['kind'];
  selfIssued?: boolean;
  tokenHash: string;
  prefix: string;
  expiresAt?: Date | null;
}

export const apiTokenColumns = {
  id: apiTokens.id,
  userId: apiTokens.userId,
  name: apiTokens.name,
  kind: apiTokens.kind,
  selfIssued: apiTokens.selfIssued,
  prefix: apiTokens.prefix,
  expiresAt: apiTokens.expiresAt,
  lastUsedAt: apiTokens.lastUsedAt,
  revokedAt: apiTokens.revokedAt,
  createdAt: apiTokens.createdAt,
};

/** API tokens of a tenant's users (ADR-011). */
export class ApiTokensRepo {
  constructor(private readonly db: Db) {}

  private async assertUser(tenantId: string, userId: string): Promise<void> {
    const [u] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)));
    if (!u) throw new NotFound('user', userId);
  }

  /** The user's non-revoked `api` tokens. */
  async list(tenantId: string, userId: string): Promise<ApiToken[]> {
    await this.assertUser(tenantId, userId);
    return this.db
      .select(apiTokenColumns)
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, userId), eq(apiTokens.kind, 'api'), isNull(apiTokens.revokedAt)))
      .orderBy(desc(apiTokens.createdAt));
  }

  async create(tenantId: string, userId: string, input: ApiTokenInput): Promise<ApiToken> {
    await this.assertUser(tenantId, userId);
    const [row] = await this.db
      .insert(apiTokens)
      .values({ ...input, userId })
      .returning(apiTokenColumns);
    return row!;
  }

  /** Revokes and returns the hash (to invalidate the verifier's caches). */
  async revoke(tenantId: string, userId: string, id: string): Promise<string> {
    const tenantUsers = this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)));
    const [row] = await this.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.id, id), inArray(apiTokens.userId, tenantUsers), isNull(apiTokens.revokedAt)))
      .returning({ tokenHash: apiTokens.tokenHash });
    if (!row) throw new NotFound('token', id);
    return row.tokenHash;
  }

  /**
   * Revokes the tokens a stolen session could have produced (sessions and self-issued tokens),
   * keeping the admin-issued ones. Returns the hashes to invalidate the verifier's caches.
   */
  async revokeUserIssued(tenantId: string, userId: string): Promise<string[]> {
    await this.assertUser(tenantId, userId);
    const rows = await this.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt), or(eq(apiTokens.kind, 'session'), eq(apiTokens.selfIssued, true))))
      .returning({ tokenHash: apiTokens.tokenHash });
    return rows.map((r) => r.tokenHash);
  }

  /** Hashes of all the user's active tokens (to invalidate caches on disable/delete). */
  async activeHashes(tenantId: string, userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ tokenHash: apiTokens.tokenHash })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(and(eq(users.tenantId, tenantId), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
    return rows.map((r) => r.tokenHash);
  }
}
