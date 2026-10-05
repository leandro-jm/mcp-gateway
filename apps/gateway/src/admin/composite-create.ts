import { CompositeParseError, parseComposite, type CompositeDefinition } from '@mcp-gateway/composition';
import { Forbidden, ValidationError } from '@mcp-gateway/core';
import type { CompositeDef } from '@mcp-gateway/db';
import type { Locale } from '@mcp-gateway/i18n';
import { msg } from '@mcp-gateway/i18n/server';
import { stringify as toYaml } from 'yaml';
import type { Principal } from '../auth/tokens';
import type { Services } from '../services';
import { compositeChecker } from './composite-check';
import { renderIssues } from './dto';
import { canManageTool } from './routes/tools';

export function parseCompositeSource(source: unknown, locale: Locale): { def: CompositeDefinition; text: string } {
  try {
    const def = parseComposite(source);
    return { def, text: typeof source === 'string' ? source : toYaml(source) };
  } catch (err) {
    if (err instanceof CompositeParseError) throw new ValidationError(err.msg, renderIssues(err.issues, locale));
    throw err;
  }
}

/**
 * Creates a composite tool, always `disabled` (default deny), with the owner-team check and the
 * `composite.create` audit. Used by `POST /composites` and by accepted suggestions (F15.23), which
 * create it as a `draft` for the owner to review in the Composer.
 */
export async function createComposite(
  services: Services,
  tenantId: string,
  principal: Principal,
  source: unknown,
  opts: { locale: Locale; ownerTeam?: string | null; draft?: boolean },
): Promise<CompositeDef> {
  const { tools, composites, audit } = services.repos;
  const ownerTeam = opts.ownerTeam ?? principal.groups[0] ?? null;
  if (!canManageTool(principal, { ownerTeam })) throw new Forbidden(msg('admin.ownerOwnTeamComposite'));
  const { def, text } = parseCompositeSource(source, opts.locale);
  const { v } = await compositeChecker(services).check(tenantId, def);
  const tool = await tools.create(tenantId, {
    kind: 'composite',
    name: def.name,
    title: def.title ?? null,
    description: def.description,
    inputSchema: def.input,
    outputSchema: null,
    annotations: v.annotations,
    state: 'disabled',
    ownerTeam,
    tags: ['composite'],
  });
  const comp = await composites.create(tenantId, {
    toolId: tool.id,
    inputSchema: def.input,
    steps: def.steps,
    outputMapping: def.output ?? null,
    failureMode: def.failure_mode,
    timeoutMs: def.timeout_ms,
    dependsOnTools: v.dependsOn,
    status: opts.draft ? 'draft' : v.valid ? 'valid' : 'invalid',
    validationErrors: v.errors,
    source: text,
  });
  await tools.update(tenantId, tool.id, { compositeDefId: comp.id });
  await audit.record(tenantId, {
    action: 'composite.create',
    subject: principal.sub,
    clientId: principal.clientId,
    toolId: tool.id,
    toolName: tool.name,
    decision: v.valid ? 'applied' : 'invalid',
    ...(opts.draft ? { details: { draft: true } } : {}),
  });
  return comp;
}
