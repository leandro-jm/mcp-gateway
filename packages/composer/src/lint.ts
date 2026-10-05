import { stepExpressions, type CompositeDefinition, type Issue } from '@mcp-gateway/composition';
import { msg } from '@mcp-gateway/i18n/server';

/**
 * Native JSONata functions a generated composite may not call (ADR-015): `$eval` evaluates
 * dynamic code and `$pad` allocates unbounded memory in a single call (ADR-013).
 */
export const FORBIDDEN_FUNCTIONS = ['$eval', '$pad'] as const;

const FORBIDDEN = /\$(eval|pad)\s*\(/g;

export interface LintContext {
  /** Names of the tools that already exist in the tenant. */
  existingNames: ReadonlySet<string>;
  /** Tools sent to the model; a generated step may only use these. */
  candidates: ReadonlySet<string>;
}

/** Extra checks for model-written composites, on top of `validateComposite`. */
export function lintGenerated(def: CompositeDefinition, ctx: LintContext): Issue[] {
  const issues: Issue[] = [];
  if (ctx.existingNames.has(def.name)) issues.push({ path: 'name', message: msg('composer.nameTaken', { name: def.name }) });

  const forbidden = (path: string, exprs: string[]) => {
    const found = new Set(exprs.flatMap((e) => [...e.matchAll(FORBIDDEN)].map((m) => `$${m[1]}`)));
    for (const fn of found) issues.push({ path, message: msg('composer.forbiddenFunction', { fn }) });
  };

  def.steps.forEach((step, i) => {
    const p = `steps[${i}](${step.id})`;
    if (!ctx.candidates.has(step.tool)) issues.push({ path: p, message: msg('composer.toolNotCandidate', { tool: step.tool }) });
    forbidden(p, stepExpressions(step));
  });
  if (def.output) forbidden('output', [def.output]);
  return issues;
}
