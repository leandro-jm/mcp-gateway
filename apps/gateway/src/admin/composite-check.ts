import { validateComposite, type CatalogTool, type CompositeDefinition } from '@mcp-gateway/composition';
import { applyOverrides, readCompositionSettings } from '@mcp-gateway/core';
import type { Services } from '../services';

/** Static validation of composites against the tenant catalog (Composer, composites API, generator). */
export function compositeChecker(services: Services) {
  const { tools, tenants } = services.repos;

  /** Every tool of the tenant (all states), by effective name. */
  async function catalog(tenantId: string): Promise<Map<string, CatalogTool>> {
    const all = await tools.listAll(tenantId);
    return new Map(
      all.map((t) => {
        const eff = applyOverrides(t);
        return [eff.name, { id: t.id, name: eff.name, kind: t.kind, state: t.state, inputSchema: eff.inputSchema, annotations: t.annotations }];
      }),
    );
  }

  async function check(tenantId: string, def: CompositeDefinition, cat?: Map<string, CatalogTool>) {
    const tenant = await tenants.get(tenantId);
    const known = cat ?? (await catalog(tenantId));
    const v = validateComposite(def, known, { maxSteps: readCompositionSettings(tenant.settings).maxSteps });
    const nameOf = new Map([...known.values()].map((t) => [t.id, t.name]));
    return { v, names: v.dependsOn.map((id) => nameOf.get(id) ?? id) };
  }

  return { catalog, check };
}
