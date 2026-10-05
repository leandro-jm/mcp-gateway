import { NotFound } from '@mcp-gateway/core';
import { and, desc, eq, gt } from 'drizzle-orm';
import type { Db } from '../client';
import { artifacts } from '../schema';

export type Artifact = typeof artifacts.$inferSelect;
export type ArtifactInput = Omit<typeof artifacts.$inferInsert, 'tenantId' | 'id' | 'createdAt'> & { id?: string };

export class ArtifactsRepo {
  constructor(private readonly db: Db) {}

  async create(tenantId: string, input: ArtifactInput): Promise<Artifact> {
    const [row] = await this.db
      .insert(artifacts)
      .values({ ...input, tenantId })
      .returning();
    return row!;
  }

  /** Valid artifact of the tenant and session (ownership checked in the database, never via the URI). */
  async getOwned(tenantId: string, sessionId: string, id: string): Promise<Artifact> {
    const [row] = await this.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.tenantId, tenantId), eq(artifacts.sessionId, sessionId), eq(artifacts.id, id), gt(artifacts.expiresAt, new Date())));
    if (!row) throw new NotFound('artifact', id);
    return row;
  }

  async listBySession(tenantId: string, sessionId: string, limit = 50): Promise<Artifact[]> {
    return this.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.tenantId, tenantId), eq(artifacts.sessionId, sessionId), gt(artifacts.expiresAt, new Date())))
      .orderBy(desc(artifacts.createdAt))
      .limit(limit);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await this.db.delete(artifacts).where(and(eq(artifacts.tenantId, tenantId), eq(artifacts.id, id)));
  }
}
