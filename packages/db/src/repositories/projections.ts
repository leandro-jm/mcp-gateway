import { and, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { projections } from '../schema';

export type Projection = typeof projections.$inferSelect;

export interface ProjectionInput {
  include?: string[];
  exclude?: string[];
  maxArrayItems?: number | null;
  maxBytes?: number | null;
  allowAgentFields?: boolean;
  status?: Projection['status'];
}

export class ProjectionsRepo {
  constructor(private readonly db: Db) {}

  async get(tenantId: string, toolId: string): Promise<Projection | undefined> {
    const [row] = await this.db
      .select()
      .from(projections)
      .where(and(eq(projections.tenantId, tenantId), eq(projections.toolId, toolId)));
    return row;
  }

  async upsert(tenantId: string, toolId: string, input: ProjectionInput): Promise<Projection> {
    const values = {
      include: input.include ?? [],
      exclude: input.exclude ?? [],
      maxArrayItems: input.maxArrayItems ?? null,
      maxBytes: input.maxBytes ?? null,
      allowAgentFields: input.allowAgentFields ?? false,
      status: input.status ?? 'active',
    };
    const [row] = await this.db
      .insert(projections)
      .values({ ...values, tenantId, toolId })
      .onConflictDoUpdate({ target: projections.toolId, set: { ...values, updatedAt: new Date() } })
      .returning();
    return row!;
  }

  /** Creates the crawl suggestion only if the tool has no projection yet. */
  async suggest(tenantId: string, toolId: string, include: string[]): Promise<boolean> {
    const rows = await this.db
      .insert(projections)
      .values({ tenantId, toolId, include, status: 'suggested' })
      .onConflictDoNothing({ target: projections.toolId })
      .returning({ id: projections.id });
    return rows.length > 0;
  }

  async delete(tenantId: string, toolId: string): Promise<boolean> {
    const rows = await this.db
      .delete(projections)
      .where(and(eq(projections.tenantId, tenantId), eq(projections.toolId, toolId)))
      .returning({ id: projections.id });
    return rows.length > 0;
  }
}
