import { Conflict, NotFound } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import { asc, count, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { tenants, type JsonObject } from '../schema';
import { isUniqueViolation, pageLimit, pageOffset, type Page, type PageOpts } from './util';

export type Tenant = Omit<typeof tenants.$inferSelect, 'dataKeyEncrypted'>;

const columns = {
  id: tenants.id,
  slug: tenants.slug,
  name: tenants.name,
  status: tenants.status,
  settings: tenants.settings,
  createdAt: tenants.createdAt,
  updatedAt: tenants.updatedAt,
};

/**
 * Tenants repository. It is the only repository that is cross-tenant by nature
 * (it manages the tenants themselves). @cross-tenant
 */
export class TenantsRepo {
  constructor(private readonly db: Db) {}

  async list(opts: PageOpts = {}): Promise<Page<Tenant>> {
    const items = await this.db
      .select(columns)
      .from(tenants)
      .orderBy(asc(tenants.slug))
      .limit(pageLimit(opts))
      .offset(pageOffset(opts));
    const [c] = await this.db.select({ n: count() }).from(tenants);
    return { items, total: c?.n ?? 0 };
  }

  async get(id: string): Promise<Tenant> {
    const [row] = await this.db.select(columns).from(tenants).where(eq(tenants.id, id));
    if (!row) throw new NotFound('tenant', id);
    return row;
  }

  async findBySlug(slug: string): Promise<Tenant | undefined> {
    const [row] = await this.db.select(columns).from(tenants).where(eq(tenants.slug, slug));
    return row;
  }

  async create(input: { slug: string; name: string; settings?: JsonObject }): Promise<Tenant> {
    try {
      const [row] = await this.db.insert(tenants).values(input).returning(columns);
      return row!;
    } catch (err) {
      if (isUniqueViolation(err)) throw new Conflict(msg('db.tenantExists', { slug: input.slug }));
      throw err;
    }
  }

  async update(
    id: string,
    patch: { name?: string; status?: Tenant['status']; settings?: JsonObject },
  ): Promise<Tenant> {
    const [row] = await this.db
      .update(tenants)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(tenants.id, id))
      .returning(columns);
    if (!row) throw new NotFound('tenant', id);
    return row;
  }

  async delete(id: string): Promise<void> {
    const rows = await this.db.delete(tenants).where(eq(tenants.id, id)).returning({ id: tenants.id });
    if (rows.length === 0) throw new NotFound('tenant', id);
  }
}
