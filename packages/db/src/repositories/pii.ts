import { NotFound } from '@mcp-gateway/core';
import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { piiRules, piiTokens } from '../schema';

export type PiiRuleRow = typeof piiRules.$inferSelect;

export interface PiiRuleInput {
  scope: PiiRuleRow['scope'];
  scopeRef?: string | null;
  detector: string;
  fieldSelector?: string | null;
  strategy: PiiRuleRow['strategy'];
  direction?: PiiRuleRow['direction'];
}

export class PiiRulesRepo {
  constructor(private readonly db: Db) {}

  async list(tenantId: string): Promise<PiiRuleRow[]> {
    return this.db.select().from(piiRules).where(eq(piiRules.tenantId, tenantId)).orderBy(asc(piiRules.createdAt));
  }

  async create(tenantId: string, input: PiiRuleInput): Promise<PiiRuleRow> {
    const [row] = await this.db
      .insert(piiRules)
      .values({ ...input, tenantId })
      .returning();
    return row!;
  }

  async update(tenantId: string, id: string, patch: Partial<PiiRuleInput>): Promise<PiiRuleRow> {
    const [row] = await this.db
      .update(piiRules)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(piiRules.tenantId, tenantId), eq(piiRules.id, id)))
      .returning();
    if (!row) throw new NotFound('piiRule', id);
    return row;
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const rows = await this.db
      .delete(piiRules)
      .where(and(eq(piiRules.tenantId, tenantId), eq(piiRules.id, id)))
      .returning({ id: piiRules.id });
    if (rows.length === 0) throw new NotFound('piiRule', id);
  }
}

export interface PiiTokenRow {
  token: string;
  detector: string;
  valueEncrypted: string;
  /** Subjects the token was shown to (merged on upsert). */
  subjects: string[];
  expiresAt: Date;
}

export class PiiTokensRepo {
  constructor(private readonly db: Db) {}

  /** Stores tokens (or extends their validity). Tokens are deterministic per tenant. */
  async upsert(tenantId: string, rows: PiiTokenRow[]): Promise<void> {
    if (!rows.length) return;
    await this.db
      .insert(piiTokens)
      .values(rows.map((r) => ({ ...r, tenantId })))
      .onConflictDoUpdate({
        target: piiTokens.token,
        set: {
          expiresAt: sql`greatest(${piiTokens.expiresAt}, excluded.expires_at)`,
          subjects: sql`array(select distinct s from unnest(${piiTokens.subjects} || excluded.subjects) as s)`,
        },
        setWhere: sql`${piiTokens.tenantId} = excluded.tenant_id`,
      });
  }

  /** Valid tokens (same tenant, not expired). */
  async find(tenantId: string, tokens: string[]): Promise<PiiTokenRow[]> {
    if (!tokens.length) return [];
    return this.db
      .select({ token: piiTokens.token, detector: piiTokens.detector, valueEncrypted: piiTokens.valueEncrypted, subjects: piiTokens.subjects, expiresAt: piiTokens.expiresAt })
      .from(piiTokens)
      .where(and(eq(piiTokens.tenantId, tenantId), inArray(piiTokens.token, tokens), gt(piiTokens.expiresAt, new Date())));
  }

  async deleteExpired(tenantId: string, now = new Date()): Promise<number> {
    const rows = await this.db
      .delete(piiTokens)
      .where(and(eq(piiTokens.tenantId, tenantId), lt(piiTokens.expiresAt, now)))
      .returning({ token: piiTokens.token });
    return rows.length;
  }
}
