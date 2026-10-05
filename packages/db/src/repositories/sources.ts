import { Conflict, NotFound, ValidationError } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import { and, asc, count, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { credentials, upstreamSources, type JsonObject } from '../schema';
import { isUniqueViolation, pageLimit, pageOffset, type Page, type PageOpts } from './util';

export type Source = typeof upstreamSources.$inferSelect;

export interface SourceInput {
  name: string;
  openapiUrl?: string | null;
  openapiInline?: JsonObject | null;
  specFormat?: Source['specFormat'];
  importMeta?: JsonObject | null;
  baseUrl: string;
  credentialId?: string | null;
  crawlSchedule?: string | null;
  ownerTeam?: string | null;
  status?: Source['status'];
  settings?: JsonObject;
}

export class SourcesRepo {
  constructor(private readonly db: Db) {}

  private async assertCredential(tenantId: string, credentialId: string | null | undefined): Promise<void> {
    if (!credentialId) return;
    const [c] = await this.db
      .select({ id: credentials.id })
      .from(credentials)
      .where(and(eq(credentials.tenantId, tenantId), eq(credentials.id, credentialId)));
    if (!c) throw new ValidationError(msg('db.credentialNotInTenant'), { credentialId });
  }

  async list(tenantId: string, opts: PageOpts = {}): Promise<Page<Source>> {
    const where = eq(upstreamSources.tenantId, tenantId);
    const items = await this.db
      .select()
      .from(upstreamSources)
      .where(where)
      .orderBy(asc(upstreamSources.name))
      .limit(pageLimit(opts))
      .offset(pageOffset(opts));
    const [c] = await this.db.select({ n: count() }).from(upstreamSources).where(where);
    return { items, total: c?.n ?? 0 };
  }

  async get(tenantId: string, id: string): Promise<Source> {
    const [row] = await this.db
      .select()
      .from(upstreamSources)
      .where(and(eq(upstreamSources.tenantId, tenantId), eq(upstreamSources.id, id)));
    if (!row) throw new NotFound('source', id);
    return row;
  }

  async create(tenantId: string, input: SourceInput): Promise<Source> {
    if (!input.openapiUrl && !input.openapiInline) {
      throw new ValidationError(msg('db.sourceSpecRequired'));
    }
    await this.assertCredential(tenantId, input.credentialId);
    try {
      const [row] = await this.db
        .insert(upstreamSources)
        .values({ ...input, tenantId })
        .returning();
      return row!;
    } catch (err) {
      if (isUniqueViolation(err)) throw new Conflict(msg('db.sourceExists', { name: input.name }));
      throw err;
    }
  }

  async update(tenantId: string, id: string, patch: Partial<SourceInput>): Promise<Source> {
    const current = await this.get(tenantId, id);
    const openapiUrl = patch.openapiUrl === undefined ? current.openapiUrl : patch.openapiUrl;
    const openapiInline = patch.openapiInline === undefined ? current.openapiInline : patch.openapiInline;
    if (!openapiUrl && !openapiInline) throw new ValidationError(msg('db.sourceSpecRequired'));
    await this.assertCredential(tenantId, patch.credentialId);
    try {
      const [row] = await this.db
        .update(upstreamSources)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(upstreamSources.tenantId, tenantId), eq(upstreamSources.id, id)))
        .returning();
      return row!;
    } catch (err) {
      if (isUniqueViolation(err)) throw new Conflict(msg('db.sourceExists', { name: patch.name ?? '' }));
      throw err;
    }
  }

  async markCrawled(tenantId: string, id: string, at = new Date()): Promise<void> {
    await this.db
      .update(upstreamSources)
      .set({ lastCrawlAt: at })
      .where(and(eq(upstreamSources.tenantId, tenantId), eq(upstreamSources.id, id)));
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const rows = await this.db
      .delete(upstreamSources)
      .where(and(eq(upstreamSources.tenantId, tenantId), eq(upstreamSources.id, id)))
      .returning({ id: upstreamSources.id });
    if (rows.length === 0) throw new NotFound('source', id);
  }
}
