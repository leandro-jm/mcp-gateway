import { Conflict, NotFound } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { virtualServers, type JsonObject } from '../schema';
import { isUniqueViolation } from './util';

export type VirtualServer = typeof virtualServers.$inferSelect;

export interface VirtualServerInput {
  slug: string;
  name?: string | null;
  description?: string | null;
  instructions?: string | null;
  toolSelector?: JsonObject;
  mode?: VirtualServer['mode'];
  icon?: string | null;
  metadata?: JsonObject;
  ownerTeam?: string | null;
}

export class VirtualServersRepo {
  constructor(private readonly db: Db) {}

  async list(tenantId: string): Promise<VirtualServer[]> {
    return this.db
      .select()
      .from(virtualServers)
      .where(eq(virtualServers.tenantId, tenantId))
      .orderBy(asc(virtualServers.slug));
  }

  async get(tenantId: string, id: string): Promise<VirtualServer> {
    const [row] = await this.db
      .select()
      .from(virtualServers)
      .where(and(eq(virtualServers.tenantId, tenantId), eq(virtualServers.id, id)));
    if (!row) throw new NotFound('virtualServer', id);
    return row;
  }

  async findBySlug(tenantId: string, slug: string): Promise<VirtualServer | undefined> {
    const [row] = await this.db
      .select()
      .from(virtualServers)
      .where(and(eq(virtualServers.tenantId, tenantId), eq(virtualServers.slug, slug)));
    return row;
  }

  async create(tenantId: string, input: VirtualServerInput): Promise<VirtualServer> {
    try {
      const [row] = await this.db
        .insert(virtualServers)
        .values({ ...input, tenantId })
        .returning();
      return row!;
    } catch (err) {
      if (isUniqueViolation(err)) throw new Conflict(msg('db.virtualServerExists', { slug: input.slug }));
      throw err;
    }
  }

  async update(tenantId: string, id: string, patch: Partial<VirtualServerInput>): Promise<VirtualServer> {
    try {
      const [row] = await this.db
        .update(virtualServers)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(virtualServers.tenantId, tenantId), eq(virtualServers.id, id)))
        .returning();
      if (!row) throw new NotFound('virtualServer', id);
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) throw new Conflict(msg('db.virtualServerExists', { slug: patch.slug ?? '' }));
      throw err;
    }
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const rows = await this.db
      .delete(virtualServers)
      .where(and(eq(virtualServers.tenantId, tenantId), eq(virtualServers.id, id)))
      .returning({ id: virtualServers.id });
    if (rows.length === 0) throw new NotFound('virtualServer', id);
  }
}
