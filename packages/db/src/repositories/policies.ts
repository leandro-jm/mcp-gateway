import { NotFound } from '@mcp-gateway/core';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { policies, type JsonObject } from '../schema';

export type Policy = typeof policies.$inferSelect;

export interface PolicyInput {
  subjectType: Policy['subjectType'];
  subject: string;
  effect: Policy['effect'];
  toolPattern: string;
  conditions?: JsonObject;
  priority?: number;
  description?: string | null;
}

export class PoliciesRepo {
  constructor(private readonly db: Db) {}

  async list(tenantId: string): Promise<Policy[]> {
    return this.db
      .select()
      .from(policies)
      .where(eq(policies.tenantId, tenantId))
      .orderBy(desc(policies.priority), asc(policies.createdAt));
  }

  async get(tenantId: string, id: string): Promise<Policy> {
    const [row] = await this.db
      .select()
      .from(policies)
      .where(and(eq(policies.tenantId, tenantId), eq(policies.id, id)));
    if (!row) throw new NotFound('policy', id);
    return row;
  }

  async create(tenantId: string, input: PolicyInput): Promise<Policy> {
    const [row] = await this.db
      .insert(policies)
      .values({ ...input, tenantId })
      .returning();
    return row!;
  }

  async update(tenantId: string, id: string, patch: Partial<PolicyInput>): Promise<Policy> {
    const [row] = await this.db
      .update(policies)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(policies.tenantId, tenantId), eq(policies.id, id)))
      .returning();
    if (!row) throw new NotFound('policy', id);
    return row;
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const rows = await this.db
      .delete(policies)
      .where(and(eq(policies.tenantId, tenantId), eq(policies.id, id)))
      .returning({ id: policies.id });
    if (rows.length === 0) throw new NotFound('policy', id);
  }
}
