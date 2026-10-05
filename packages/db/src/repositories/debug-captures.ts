import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { debugCaptureItems, debugCaptures } from '../schema';

export type DebugCapture = typeof debugCaptures.$inferSelect;
export type DebugCaptureItem = typeof debugCaptureItems.$inferSelect;
export type DebugCaptureFilter = DebugCapture['filter'];

/** Debug capture sessions and their items (F15.17, ADR-017). */
export class DebugCapturesRepo {
  constructor(private readonly db: Db) {}

  async create(tenantId: string, input: { createdBy: string; reason: string; filter: DebugCaptureFilter; maxCalls: number; expiresAt: Date }): Promise<DebugCapture> {
    const [row] = await this.db.insert(debugCaptures).values({ ...input, tenantId }).returning();
    return row!;
  }

  async list(tenantId: string, limit = 50): Promise<DebugCapture[]> {
    return this.db.select().from(debugCaptures).where(eq(debugCaptures.tenantId, tenantId)).orderBy(desc(debugCaptures.createdAt)).limit(limit);
  }

  async get(tenantId: string, id: string): Promise<DebugCapture | undefined> {
    const [row] = await this.db.select().from(debugCaptures).where(and(eq(debugCaptures.tenantId, tenantId), eq(debugCaptures.id, id)));
    return row;
  }

  async stop(tenantId: string, id: string): Promise<DebugCapture | undefined> {
    const [row] = await this.db
      .update(debugCaptures)
      .set({ status: 'stopped' })
      .where(and(eq(debugCaptures.tenantId, tenantId), eq(debugCaptures.id, id)))
      .returning();
    return row;
  }

  /** Captures still collecting calls. */
  async active(tenantId: string, now = new Date()): Promise<DebugCapture[]> {
    return this.db
      .select()
      .from(debugCaptures)
      .where(
        and(
          eq(debugCaptures.tenantId, tenantId),
          eq(debugCaptures.status, 'active'),
          gt(debugCaptures.expiresAt, now),
          lt(debugCaptures.capturedCount, debugCaptures.maxCalls),
        ),
      );
  }

  /** Takes one slot of the capture atomically (several replicas may race for the last one). */
  async claim(tenantId: string, id: string, now = new Date()): Promise<boolean> {
    const rows = await this.db
      .update(debugCaptures)
      .set({ capturedCount: sql`${debugCaptures.capturedCount} + 1` })
      .where(
        and(
          eq(debugCaptures.tenantId, tenantId),
          eq(debugCaptures.id, id),
          eq(debugCaptures.status, 'active'),
          gt(debugCaptures.expiresAt, now),
          lt(debugCaptures.capturedCount, debugCaptures.maxCalls),
        ),
      )
      .returning({ id: debugCaptures.id });
    return rows.length > 0;
  }

  async addItem(tenantId: string, item: Omit<DebugCaptureItem, 'tenantId' | 'createdAt'>): Promise<void> {
    await this.db.insert(debugCaptureItems).values({ ...item, tenantId }).onConflictDoNothing();
  }

  async item(tenantId: string, callId: string, now = new Date()): Promise<DebugCaptureItem | undefined> {
    const [row] = await this.db
      .select()
      .from(debugCaptureItems)
      .where(and(eq(debugCaptureItems.tenantId, tenantId), eq(debugCaptureItems.callId, callId), gt(debugCaptureItems.expiresAt, now)));
    return row;
  }

  async items(tenantId: string, captureId: string): Promise<DebugCaptureItem[]> {
    return this.db
      .select()
      .from(debugCaptureItems)
      .where(and(eq(debugCaptureItems.tenantId, tenantId), eq(debugCaptureItems.captureId, captureId)))
      .orderBy(desc(debugCaptureItems.createdAt));
  }
}

/**
 * Expiry of debug captures across tenants (maintenance job). Never exposed by the Admin API.
 * @cross-tenant
 */
export class DebugCaptureMaintenance {
  constructor(private readonly db: Db) {}

  async expiredItems(now = new Date(), limit = 500): Promise<Array<{ callId: string; objectKey: string }>> {
    return this.db
      .select({ callId: debugCaptureItems.callId, objectKey: debugCaptureItems.objectKey })
      .from(debugCaptureItems)
      .where(lt(debugCaptureItems.expiresAt, now))
      .limit(limit);
  }

  async deleteItems(callIds: string[]): Promise<void> {
    for (const callId of callIds) await this.db.delete(debugCaptureItems).where(eq(debugCaptureItems.callId, callId));
  }

  async expireCaptures(now = new Date()): Promise<number> {
    const rows = await this.db
      .update(debugCaptures)
      .set({ status: 'expired' })
      .where(and(eq(debugCaptures.status, 'active'), lt(debugCaptures.expiresAt, now)))
      .returning({ id: debugCaptures.id });
    return rows.length;
  }
}
