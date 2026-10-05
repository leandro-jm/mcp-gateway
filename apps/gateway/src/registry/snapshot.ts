import { applyOverrides, type ToolKind, type ToolState } from '@mcp-gateway/core';
import { piiRules, policies, projections, type Db, type OperationRef, type ToolAnnotations } from '@mcp-gateway/db';
import { eq } from 'drizzle-orm';
import type { Repos } from '../services';

/** Registry view consumed by the data plane (plain JSON, serializable to Redis). */
export interface SnapshotTool {
  id: string;
  kind: ToolKind;
  sourceId: string | null;
  compositeDefId: string | null;
  name: string;
  baseName: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  annotations: ToolAnnotations;
  state: ToolState;
  operationRef: OperationRef | null;
  ownerTeam: string | null;
  version: number;
  tags: string[];
}

export interface SnapshotSource {
  id: string;
  name: string;
  baseUrl: string;
  credentialId: string | null;
  status: string;
  settings: Record<string, unknown>;
}

export interface SnapshotVirtualServer {
  id: string;
  slug: string;
  name: string | null;
  description: string | null;
  instructions: string | null;
  toolSelector: Record<string, unknown>;
  mode: 'full' | 'omni';
  icon: string | null;
}

export type SnapshotPolicy = Omit<typeof policies.$inferSelect, 'createdAt' | 'updatedAt'>;
export type SnapshotPiiRule = Omit<typeof piiRules.$inferSelect, 'createdAt' | 'updatedAt'>;
export type SnapshotProjection = Omit<typeof projections.$inferSelect, 'createdAt' | 'updatedAt'>;

export interface SnapshotComposite {
  id: string;
  toolId: string | null;
  status: 'draft' | 'valid' | 'invalid';
  version: number;
  definition: {
    input: Record<string, unknown>;
    steps: unknown[];
    output?: string;
    failure_mode: 'abort' | 'partial';
    timeout_ms: number;
  };
}

export interface RegistrySnapshot {
  tenant: { id: string; slug: string; status: string; settings: Record<string, unknown> };
  builtAt: string;
  /** Registry generation at build time (incremented on every invalidation). */
  generation: number;
  tools: SnapshotTool[];
  sources: SnapshotSource[];
  virtualServers: SnapshotVirtualServer[];
  policies: SnapshotPolicy[];
  piiRules: SnapshotPiiRule[];
  projections: SnapshotProjection[];
  composites: SnapshotComposite[];
}

const strip = <T extends { createdAt: Date; updatedAt: Date }>({ createdAt: _c, updatedAt: _u, ...rest }: T) => rest;

export async function buildSnapshot(
  db: Db,
  repos: Repos,
  tenantId: string,
  generation = 0,
): Promise<RegistrySnapshot> {
  const [tenant, tools, sources, vss, pols, pii, projs, comps] = await Promise.all([
    repos.tenants.get(tenantId),
    repos.tools.listAll(tenantId, ['enabled', 'disabled', 'deprecated']),
    repos.sources.list(tenantId, { limit: 500 }),
    repos.virtualServers.list(tenantId),
    db.select().from(policies).where(eq(policies.tenantId, tenantId)),
    db.select().from(piiRules).where(eq(piiRules.tenantId, tenantId)),
    db.select().from(projections).where(eq(projections.tenantId, tenantId)),
    repos.composites.list(tenantId),
  ]);
  return {
    tenant: { id: tenant.id, slug: tenant.slug, status: tenant.status, settings: tenant.settings },
    builtAt: new Date().toISOString(),
    generation,
    tools: tools.map((t) => {
      const eff = applyOverrides(t);
      return {
        id: t.id,
        kind: t.kind,
        sourceId: t.sourceId,
        compositeDefId: t.compositeDefId,
        name: eff.name,
        baseName: eff.baseName,
        title: eff.title,
        description: eff.description,
        inputSchema: eff.inputSchema,
        outputSchema: t.outputSchema,
        annotations: t.annotations,
        state: t.state,
        operationRef: t.operationRef,
        ownerTeam: t.ownerTeam,
        version: t.version,
        tags: t.tags,
      };
    }),
    sources: sources.items.map((s) => ({
      id: s.id,
      name: s.name,
      baseUrl: s.baseUrl,
      credentialId: s.credentialId,
      status: s.status,
      settings: s.settings,
    })),
    virtualServers: vss.map((v) => ({
      id: v.id,
      slug: v.slug,
      name: v.name,
      description: v.description,
      instructions: v.instructions,
      toolSelector: v.toolSelector,
      mode: v.mode,
      icon: v.icon,
    })),
    policies: pols.map(strip),
    piiRules: pii.map(strip),
    projections: projs.map(strip),
    composites: comps.map((c) => ({
      id: c.id,
      toolId: c.toolId,
      status: c.status,
      version: c.version,
      definition: {
        input: c.inputSchema,
        steps: c.steps,
        ...(c.outputMapping ? { output: c.outputMapping } : {}),
        failure_mode: c.failureMode,
        timeout_ms: c.timeoutMs,
      },
    })),
  };
}
