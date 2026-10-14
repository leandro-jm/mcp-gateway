import { and, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { tenantThemes, toolViews, type JsonObject } from '../schema';

export type ToolView = typeof toolViews.$inferSelect;
export type TenantTheme = typeof tenantThemes.$inferSelect;
export type ToolViewStatus = ToolView['status'];

/** UI attached to tools (ADR-022). The `views` JSON is validated by the caller (`view-spec`). */
export class ToolViewsRepo {
  constructor(private readonly db: Db) {}

  async get(tenantId: string, toolId: string): Promise<ToolView | undefined> {
    const [row] = await this.db
      .select()
      .from(toolViews)
      .where(and(eq(toolViews.tenantId, tenantId), eq(toolViews.toolId, toolId)));
    return row;
  }

  async upsert(tenantId: string, toolId: string, views: JsonObject, status: ToolViewStatus, specVersion = 1): Promise<ToolView> {
    const [row] = await this.db
      .insert(toolViews)
      .values({ tenantId, toolId, views, status, specVersion })
      .onConflictDoUpdate({ target: toolViews.toolId, set: { views, status, specVersion, updatedAt: new Date() } })
      .returning();
    return row!;
  }

  /** Stores the crawl suggestion only if the tool has no view yet (an owner's choice is never overwritten). */
  async suggest(tenantId: string, toolId: string, views: JsonObject, specVersion = 1): Promise<boolean> {
    const rows = await this.db
      .insert(toolViews)
      .values({ tenantId, toolId, views, specVersion, status: 'suggested' })
      .onConflictDoNothing({ target: toolViews.toolId })
      .returning({ id: toolViews.id });
    return rows.length > 0;
  }

  async delete(tenantId: string, toolId: string): Promise<boolean> {
    const rows = await this.db
      .delete(toolViews)
      .where(and(eq(toolViews.tenantId, tenantId), eq(toolViews.toolId, toolId)))
      .returning({ id: toolViews.id });
    return rows.length > 0;
  }
}

export interface TenantThemeInput {
  tokens: JsonObject;
  tileUrl?: string | null;
  tileAttribution?: string | null;
}

/** Branding of a tenant's views (ADR-022). Tokens are validated by the caller (`validateTheme`). */
export class TenantThemesRepo {
  constructor(private readonly db: Db) {}

  async get(tenantId: string): Promise<TenantTheme | undefined> {
    const [row] = await this.db.select().from(tenantThemes).where(eq(tenantThemes.tenantId, tenantId));
    return row;
  }

  async upsert(tenantId: string, input: TenantThemeInput): Promise<TenantTheme> {
    const values = { tokens: input.tokens, tileUrl: input.tileUrl ?? null, tileAttribution: input.tileAttribution ?? null };
    const [row] = await this.db
      .insert(tenantThemes)
      .values({ tenantId, ...values })
      .onConflictDoUpdate({ target: tenantThemes.tenantId, set: { ...values, updatedAt: new Date() } })
      .returning();
    return row!;
  }

  async delete(tenantId: string): Promise<boolean> {
    const rows = await this.db.delete(tenantThemes).where(eq(tenantThemes.tenantId, tenantId)).returning({ tenantId: tenantThemes.tenantId });
    return rows.length > 0;
  }
}
