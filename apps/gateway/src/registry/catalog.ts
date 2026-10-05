import { globMatch } from '@mcp-gateway/core';
import type { RegistrySnapshot, SnapshotTool, SnapshotVirtualServer } from './snapshot';

export interface ToolSelector {
  /** Ids or names. */
  tools?: string[];
  /** Globs over the name. */
  patterns?: string[];
  /** Tools with any of these tags. */
  tags?: string[];
  /** Restricts the items above to these kinds. */
  kinds?: Array<'openapi' | 'manual' | 'composite'>;
}

export function matchesSelector(t: Pick<SnapshotTool, 'id' | 'name' | 'kind' | 'tags'>, sel: ToolSelector): boolean {
  if (sel.kinds?.length && !sel.kinds.includes(t.kind)) return false;
  const ids = sel.tools ?? [];
  return (
    ids.includes(t.id) ||
    ids.includes(t.name) ||
    (sel.patterns ?? []).some((p) => globMatch(p, t.name)) ||
    (sel.tags ?? []).some((tag) => t.tags.includes(tag)) ||
    // `kinds` alone (no other criteria) selects every tool of those kinds
    (!ids.length && !sel.patterns?.length && !sel.tags?.length && Boolean(sel.kinds?.length))
  );
}

/** Catalog tools: the virtual server defines the catalog; policies (F4) define access. */
export function selectTools(snapshot: RegistrySnapshot, vs?: SnapshotVirtualServer): SnapshotTool[] {
  if (!vs) return snapshot.tools;
  const sel = vs.toolSelector as ToolSelector;
  return snapshot.tools.filter((t) => matchesSelector(t, sel));
}

export function findVirtualServer(snapshot: RegistrySnapshot, slug: string): SnapshotVirtualServer | undefined {
  return snapshot.virtualServers.find((v) => v.slug === slug);
}
