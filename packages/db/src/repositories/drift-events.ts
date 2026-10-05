import { NotFound } from '@mcp-gateway/core';
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import type { Db } from '../client';
import { driftEvents, type JsonObject } from '../schema';
import { pageLimit, pageOffset, type PageOpts } from './util';

export type DriftEvent = typeof driftEvents.$inferSelect;
export type DriftKind = DriftEvent['kind'];

export class DriftEventsRepo {
  constructor(private readonly db: Db) {}

  async create(tenantId: string, input: { toolId: string; kind: DriftKind; diff: JsonObject }): Promise<DriftEvent> {
    const [row] = await this.db
      .insert(driftEvents)
      .values({ ...input, tenantId })
      .returning();
    return row!;
  }

  async list(
    tenantId: string,
    f: PageOpts & { toolId?: string; kind?: DriftKind; pending?: boolean } = {},
  ): Promise<DriftEvent[]> {
    const conds: SQL[] = [eq(driftEvents.tenantId, tenantId)];
    if (f.toolId) conds.push(eq(driftEvents.toolId, f.toolId));
    if (f.kind) conds.push(eq(driftEvents.kind, f.kind));
    if (f.pending) conds.push(isNull(driftEvents.acknowledgedAt));
    return this.db
      .select()
      .from(driftEvents)
      .where(and(...conds))
      .orderBy(desc(driftEvents.createdAt))
      .limit(pageLimit(f))
      .offset(pageOffset(f));
  }

  async get(tenantId: string, id: string): Promise<DriftEvent> {
    const [row] = await this.db
      .select()
      .from(driftEvents)
      .where(and(eq(driftEvents.tenantId, tenantId), eq(driftEvents.id, id)));
    if (!row) throw new NotFound('driftEvent', id);
    return row;
  }

  async acknowledge(tenantId: string, id: string, by: string): Promise<DriftEvent> {
    const [row] = await this.db
      .update(driftEvents)
      .set({ acknowledgedBy: by, acknowledgedAt: new Date() })
      .where(and(eq(driftEvents.tenantId, tenantId), eq(driftEvents.id, id)))
      .returning();
    if (!row) throw new NotFound('driftEvent', id);
    return row;
  }
}
