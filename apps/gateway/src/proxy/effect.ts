import { LOCALES, type Locale } from '@mcp-gateway/i18n';
import { msg, translate, type ServerMessageKey } from '@mcp-gateway/i18n/server';
import type { SnapshotTool } from '../registry/snapshot';

function effectKey(annotations: SnapshotTool['annotations']): ServerMessageKey {
  if (annotations.readOnlyHint) return 'mcp.effectReadOnly';
  if (annotations.destructiveHint) return 'mcp.effectDestructive';
  return 'mcp.effectWrites';
}

/**
 * Tool description as shown to agents, with the effect sentence ("Read-only.", "Modifies data.")
 * derived from the annotations in the caller's locale (ADR-012). The toolgen no longer persists it.
 *
 * Only `openapi` tools get the suffix: their descriptions are generated (and used to carry it),
 * while `manual` and `composite` descriptions are authored by humans and never had it.
 * Nothing is appended when the description already ends with the sentence in any locale
 * (e.g. a tenant override that kept it).
 */
export function describeTool(tool: Pick<SnapshotTool, 'kind' | 'description' | 'annotations'>, locale: Locale): string {
  if (tool.kind !== 'openapi') return tool.description;
  const key = effectKey(tool.annotations);
  const description = tool.description.trimEnd();
  if (LOCALES.some((l) => description.endsWith(translate(msg(key), l)))) return tool.description;
  const sentence = translate(msg(key), locale);
  return description ? `${description} ${sentence}` : sentence;
}
