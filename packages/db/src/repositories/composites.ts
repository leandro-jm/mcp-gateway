import { NotFound } from '@mcp-gateway/core';
import { msg, raw, translate, type ServerMessage } from '@mcp-gateway/i18n/server';
import { and, arrayOverlaps, eq, inArray, ne } from 'drizzle-orm';
import type { Db } from '../client';
import { compositeDefinitions, driftEvents, tools, type JsonObject } from '../schema';
import type { DriftEvent } from './drift-events';

export type CompositeDef = typeof compositeDefinitions.$inferSelect;

export interface CompositeInput {
  toolId?: string | null;
  version?: number;
  inputSchema: JsonObject;
  steps: unknown[];
  outputMapping?: string | null;
  failureMode: CompositeDef['failureMode'];
  timeoutMs: number;
  dependsOnTools: string[];
  status: CompositeDef['status'];
  validationErrors?: unknown[] | null;
  source?: string | null;
}

/** A base tool whose change invalidates the composites that depend on it. */
export interface ChangedDependency {
  id: string;
  name: string;
  /** Why it changed, e.g. `msg('db.reasonRemovedFromSpec')`. Plain strings are kept as-is. */
  reason: ServerMessage | string;
}

export class CompositesRepo {
  constructor(private readonly db: Db) {}

  async list(tenantId: string): Promise<CompositeDef[]> {
    return this.db.select().from(compositeDefinitions).where(eq(compositeDefinitions.tenantId, tenantId));
  }

  async get(tenantId: string, id: string): Promise<CompositeDef> {
    const [row] = await this.db
      .select()
      .from(compositeDefinitions)
      .where(and(eq(compositeDefinitions.tenantId, tenantId), eq(compositeDefinitions.id, id)));
    if (!row) throw new NotFound('composite', id);
    return row;
  }

  async getByTool(tenantId: string, toolId: string): Promise<CompositeDef | undefined> {
    const [row] = await this.db
      .select()
      .from(compositeDefinitions)
      .where(and(eq(compositeDefinitions.tenantId, tenantId), eq(compositeDefinitions.toolId, toolId)));
    return row;
  }

  async create(tenantId: string, input: CompositeInput): Promise<CompositeDef> {
    const [row] = await this.db
      .insert(compositeDefinitions)
      .values({ ...input, tenantId })
      .returning();
    return row!;
  }

  async update(tenantId: string, id: string, patch: Partial<CompositeInput>): Promise<CompositeDef> {
    const [row] = await this.db
      .update(compositeDefinitions)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(compositeDefinitions.tenantId, tenantId), eq(compositeDefinitions.id, id)))
      .returning();
    if (!row) throw new NotFound('composite', id);
    return row;
  }

  /**
   * Cascading drift (F7b.5): composites that depend on the changed tools become `invalid`, the
   * composite tool goes to `disabled` and a `breaking` drift is raised for the composite's owner.
   * Validation issues are persisted in Message form (`{ path, message: { key, params } }`, ADR-012);
   * the drift summary and dependency reasons are persisted in English.
   */
  async invalidateDependents(tenantId: string, input: ChangedDependency[]): Promise<DriftEvent[]> {
    if (!input.length) return [];
    const changed = input.map((c) => ({ ...c, reason: typeof c.reason === 'string' ? raw(c.reason) : c.reason }));
    const ids = changed.map((c) => c.id);
    const affected = await this.db
      .select()
      .from(compositeDefinitions)
      .where(and(eq(compositeDefinitions.tenantId, tenantId), arrayOverlaps(compositeDefinitions.dependsOnTools, ids)));
    const events: DriftEvent[] = [];
    for (const def of affected) {
      const causes = changed.filter((c) => def.dependsOnTools.includes(c.id));
      const reasons = causes.map((c) => ({ path: `dependency.${c.name}`, message: msg('db.dependencyChanged', { name: c.name, reason: c.reason }) }));
      await this.db
        .update(compositeDefinitions)
        .set({ status: 'invalid', validationErrors: [...((def.validationErrors as unknown[]) ?? []), ...reasons], updatedAt: new Date() })
        .where(eq(compositeDefinitions.id, def.id));
      if (!def.toolId) continue;
      await this.db
        .update(tools)
        .set({ state: 'disabled', updatedAt: new Date() })
        .where(and(eq(tools.tenantId, tenantId), eq(tools.id, def.toolId), ne(tools.state, 'removed')));
      const [ev] = await this.db
        .insert(driftEvents)
        .values({
          tenantId,
          toolId: def.toolId,
          kind: 'breaking',
          diff: {
            summary: `composite invalidated: ${causes.map((c) => `${c.name} (${translate(c.reason)})`).join(', ')}`,
            cascade: true,
            dependencies: causes.map((c) => ({ toolId: c.id, name: c.name, reason: translate(c.reason) })),
          },
        })
        .returning();
      events.push(ev!);
    }
    return events;
  }

  async byIds(tenantId: string, ids: string[]): Promise<CompositeDef[]> {
    if (!ids.length) return [];
    return this.db
      .select()
      .from(compositeDefinitions)
      .where(and(eq(compositeDefinitions.tenantId, tenantId), inArray(compositeDefinitions.id, ids)));
  }
}
