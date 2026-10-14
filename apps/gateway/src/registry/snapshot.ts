import { applyOverrides, type ToolKind, type ToolState } from '@mcp-gateway/core';
import { piiRules, policies, projections, tenantThemes, toolViews, type Db, type OperationRef, type ToolAnnotations } from '@mcp-gateway/db';
import { parseToolViews, validateSpec, validateTheme, type ThemeTokens, type ToolViews } from '@mcp-ui-kit/view-spec';
import { and, eq } from 'drizzle-orm';
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

/** Active UI of a tool (ADR-022): only specs that still match the tool contract get here. */
export interface SnapshotToolView {
  toolId: string;
  views: ToolViews;
}

export interface SnapshotTheme {
  tokens: ThemeTokens;
  tileUrl: string | null;
  tileAttribution: string | null;
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
  /** Absent on snapshots cached before F18: read with `?? []`. */
  toolViews?: SnapshotToolView[];
  theme?: SnapshotTheme | null;
}

const strip = <T extends { createdAt: Date; updatedAt: Date }>({ createdAt: _c, updatedAt: _u, ...rest }: T) => rest;

export async function buildSnapshot(
  db: Db,
  repos: Repos,
  tenantId: string,
  generation = 0,
): Promise<RegistrySnapshot> {
  const [tenant, tools, sources, vss, pols, pii, projs, comps, views, themes] = await Promise.all([
    repos.tenants.get(tenantId),
    repos.tools.listAll(tenantId, ['enabled', 'disabled', 'deprecated']),
    repos.sources.list(tenantId, { limit: 500 }),
    repos.virtualServers.list(tenantId),
    db.select().from(policies).where(eq(policies.tenantId, tenantId)),
    db.select().from(piiRules).where(eq(piiRules.tenantId, tenantId)),
    db.select().from(projections).where(eq(projections.tenantId, tenantId)),
    repos.composites.list(tenantId),
    db.select().from(toolViews).where(and(eq(toolViews.tenantId, tenantId), eq(toolViews.status, 'active'))),
    db.select().from(tenantThemes).where(eq(tenantThemes.tenantId, tenantId)),
  ]);
  const snapshotTools = tools.map((t) => {
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
  });
  const byId = new Map(snapshotTools.map((t) => [t.id, t]));
  const theme = themes[0];
  return {
    tenant: { id: tenant.id, slug: tenant.slug, status: tenant.status, settings: tenant.settings },
    builtAt: new Date().toISOString(),
    generation,
    tools: snapshotTools,
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
    toolViews: views.flatMap((v) => {
      const tool = byId.get(v.toolId);
      const parsed = parseToolViews(v.views);
      // a view that no longer matches the tool contract (drift, rename) is left out, never half-applied
      if (!tool || !parsed.ok) return [];
      const issues = validateSpec(parsed.value, { name: tool.name, inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}), annotations: tool.annotations });
      return issues.length ? [] : [{ toolId: v.toolId, views: parsed.value }];
    }),
    theme: theme && !validateTheme(theme.tokens as ThemeTokens).errors.length ? { tokens: theme.tokens as ThemeTokens, tileUrl: theme.tileUrl, tileAttribution: theme.tileAttribution } : null,
  };
}
