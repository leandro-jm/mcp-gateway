import { stepDependencies, topoLevels, type CompositeDefinition } from './definition';

export interface GraphNode {
  id: string;
  tool: string;
  /** Parallel level (column) of the step; steps on the same level run concurrently. */
  level: number;
  conditional: boolean;
  foreach: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface CompositeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * DAG of a composite for display: one node per step and one edge per `$steps.<id>` reference.
 * Lenient: references to unknown steps are dropped and, on a cycle, every step gets its own level
 * (the validator reports both).
 */
export function compositeGraph(def: CompositeDefinition): CompositeGraph {
  const ids = new Set(def.steps.map((s) => s.id));
  let levelOf: Map<string, number>;
  try {
    levelOf = new Map(topoLevels(def.steps).flatMap((level, i) => level.map((id) => [id, i] as const)));
  } catch {
    levelOf = new Map(def.steps.map((s, i) => [s.id, i]));
  }
  const nodes = def.steps.map((s, i) => ({
    id: s.id,
    tool: s.tool,
    level: levelOf.get(s.id) ?? i,
    conditional: s.when !== undefined,
    foreach: s.foreach !== undefined,
  }));
  const edges = def.steps.flatMap((s) =>
    stepDependencies(s)
      .filter((d) => d !== s.id && ids.has(d))
      .map((d) => ({ from: d, to: s.id })),
  );
  return { nodes, edges };
}
