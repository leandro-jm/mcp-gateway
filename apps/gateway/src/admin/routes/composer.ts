import { createHash } from 'node:crypto';
import {
  buildContext,
  buildSystemPrompt,
  buildUserMessage,
  COMPOSER_LIMITS,
  issuesForRepair,
  lintGenerated,
  parseProposal,
  PROPOSAL_JSON_SCHEMA,
  ProposalError,
  type ComposerTool,
  type Proposal,
} from '@mcp-gateway/composer';
import {
  compositeGraph,
  CompositeParseError,
  parseComposite,
  ROOT_PATH,
  type CompositeDefinition,
  type Issue,
  type ValidationResult,
} from '@mcp-gateway/composition';
import { applyOverrides, Forbidden, GatewayError, NotFound, readCompositionSettings, ValidationError } from '@mcp-gateway/core';
import type { Locale } from '@mcp-gateway/i18n';
import { msg, translate } from '@mcp-gateway/i18n/server';
import { redactText } from '@mcp-gateway/redaction';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authorize } from '../../auth/authorizer';
import { requestLocale } from '../../i18n';
import { tenantLlm, type LlmUsage } from '../../llm';
import type { SnapshotTool } from '../../registry/snapshot';
import type { Services } from '../../services';
import { matchesSelector, type ToolSelector } from '../../registry/catalog';
import { isAdmin, requirePrincipal, resolveTenantId, ROLE } from '../auth';
import { compositeChecker } from '../composite-check';
import { renderIssues } from '../dto';
import { composerGenerateSchema, composerProposalSchema, compositeReadinessSchema, errorResponses, readinessQuery, uuidParam } from '../schemas';
import { canManageTool } from './tools';

/** Overall budget of one generation (all attempts); the reverse proxy must allow more (ADR-015). */
const GENERATION_BUDGET_MS = 120_000;
const MAX_OUTPUT_TOKENS = 16_000;
/** Masking only needs the detectors; hash/tokenize strategies are not used on the prompt. */
const PROMPT_REDACTION_KEY = Buffer.alloc(32, 0);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Tool names of a previous definition, to keep them in the catalog when refining. */
function toolsOf(source: string | undefined): string[] {
  if (!source) return [];
  try {
    return parseComposite(source).steps.map((s) => s.tool);
  } catch {
    return [...source.matchAll(/^\s*-?\s*tool:\s*["']?([\w.-]+)/gm)].map((m) => m[1]!);
  }
}

function toComposerTool(t: SnapshotTool): ComposerTool {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    state: t.state,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    ...(t.operationRef?.mapping?.response?.wrap ? { responseWrap: t.operationRef.mapping.response.wrap } : {}),
    annotations: t.annotations,
  };
}

interface Attempt {
  proposal: Proposal;
  def?: CompositeDefinition;
  v?: ValidationResult;
  names: string[];
  /** Validator errors plus the lint of generated composites. */
  issues: Issue[];
}

/**
 * Natural-language composer (F14.5, ADR-015): the tenant's LLM drafts a composite over the catalog,
 * the usual validator checks it and its errors go back to the model for repair. Nothing is saved.
 */
export const composerRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (app, { services }) => {
  const { catalog, check } = compositeChecker(services);

  app.post('/composites/generate', {
    config: { roles: [ROLE.admin, ROLE.owner] },
    schema: {
      tags: ['composites'],
      summary: 'Drafts a composite from natural language with the tenant LLM (nothing is saved)',
      body: composerGenerateSchema,
      response: { 200: composerProposalSchema, ...errorResponses },
    },
    handler: async (req, reply) => {
      const started = Date.now();
      const tenantId = await resolveTenantId(services, req);
      const principal = requirePrincipal(req);
      const locale: Locale = requestLocale(req);
      const { settings, provider } = await tenantLlm(services, tenantId);
      const hourly = settings.maxGenerationsPerHour;
      await services.rateLimiter.check([
        { scope: 'composer', key: `llm:gen:${tenantId}`, limit: { limit: hourly, windowSec: 3600 } },
        // one user cannot spend the whole tenant budget
        { scope: 'composer', key: `llm:gen:${tenantId}:${principal.sub}`, limit: { limit: Math.max(1, Math.ceil(hourly / 2)), windowSec: 3600 } },
      ]);

      // PII never leaves the gateway: the request text is masked before reaching the provider
      const redactOpts = { direction: 'request' as const, rules: [], key: PROMPT_REDACTION_KEY, locale };
      const prompt = redactText(req.body.prompt, redactOpts).value;
      const refinement = req.body.refinement ? redactText(req.body.refinement, redactOpts).value : undefined;

      const snapshot = await services.registry.get(tenantId);
      const usable = snapshot.tools.filter((t) => t.state !== 'removed' && t.kind !== 'composite');
      if (!usable.length) throw new ValidationError(msg('composer.noCandidates'));
      const byName = new Map(usable.map((t) => [t.name, t]));
      const candidates = new Map<string, { tool: SnapshotTool; score: number | null }>();
      for (const name of [...(req.body.tools ?? []), ...toolsOf(req.body.previous)]) {
        const t = byName.get(name);
        if (t) candidates.set(t.name, { tool: t, score: null });
      }
      const ranked = await services.search.search(tenantId, [prompt, refinement].filter(Boolean).join('\n'), usable, COMPOSER_LIMITS.maxCandidates);
      for (const r of ranked) if (!candidates.has(r.tool.name)) candidates.set(r.tool.name, { tool: r.tool, score: r.score });
      if (!candidates.size) {
        const fallback = [...usable].sort((a, b) => Number(b.state === 'enabled') - Number(a.state === 'enabled')).slice(0, COMPOSER_LIMITS.maxCandidates);
        for (const t of fallback) candidates.set(t.name, { tool: t, score: null });
      }
      const composerTools = [...candidates.values()].map((c) => toComposerTool(c.tool));

      const cat = await catalog(tenantId);
      const lintCtx = { existingNames: new Set(cat.keys()), candidates: new Set(composerTools.map((t) => t.name)) };
      const system = buildSystemPrompt({ maxSteps: readCompositionSettings(snapshot.tenant.settings).maxSteps });
      const context = buildContext(composerTools);

      async function evaluate(proposal: Proposal): Promise<Attempt> {
        let def: CompositeDefinition;
        try {
          def = parseComposite(proposal.definition_yaml);
        } catch (err) {
          if (err instanceof CompositeParseError) return { proposal, names: [], issues: err.issues };
          throw err;
        }
        const { v, names } = await check(tenantId, def, cat);
        return { proposal, def, v, names, issues: [...v.errors, ...lintGenerated(def, lintCtx)] };
      }

      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), GENERATION_BUDGET_MS);
      reply.raw.once('close', () => {
        if (!reply.raw.writableEnded) abort.abort();
      });
      const usage: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      let model = provider.model;
      let attempts = 0;
      let last: Attempt | undefined;
      const audit = (decision: string, details: Record<string, unknown>) =>
        services.repos.audit.record(tenantId, {
          action: 'composite.generate',
          subject: principal.sub,
          clientId: principal.clientId,
          decision,
          latencyMs: Date.now() - started,
          details: {
            provider: provider.provider,
            model,
            // the prompt may hold PII: only its hash and size are kept
            promptSha256: sha256(req.body.prompt),
            promptChars: req.body.prompt.length,
            refinement: Boolean(refinement),
            attempts,
            candidates: candidates.size,
            ...usage,
            ...details,
          },
        });

      try {
        let previous = req.body.previous;
        let pendingRefinement = refinement;
        let errors: string[] | undefined;
        while (attempts <= COMPOSER_LIMITS.maxRepairs) {
          attempts++;
          const res = await provider.generate({
            system,
            context,
            user: buildUserMessage({ request: prompt, locale, previous, refinement: pendingRefinement, errors }),
            schema: PROPOSAL_JSON_SCHEMA,
            maxTokens: MAX_OUTPUT_TOKENS,
            signal: abort.signal,
          });
          usage.inputTokens += res.usage.inputTokens;
          usage.outputTokens += res.usage.outputTokens;
          usage.cacheReadTokens += res.usage.cacheReadTokens;
          model = res.model;
          if (res.stop === 'refusal') {
            last = { proposal: { definition_yaml: previous ?? '', explanation: '', assumptions: [], unsupported: translate(msg('llm.refused'), locale) }, names: [], issues: [] };
            break;
          }
          let proposal: Proposal;
          try {
            proposal = parseProposal(res.output);
          } catch (err) {
            if (!(err instanceof ProposalError)) throw err;
            const issue: Issue = { path: ROOT_PATH, message: res.stop === 'max_tokens' ? msg('llm.truncated') : err.msg };
            last = { proposal: last?.proposal ?? { definition_yaml: previous ?? '', explanation: '', assumptions: [], unsupported: null }, names: [], issues: [issue] };
            errors = issuesForRepair([issue]);
            continue;
          }
          // the model says the catalog cannot do it and offers nothing to validate
          if (!proposal.definition_yaml.trim()) {
            last = { proposal, names: [], issues: [] };
            break;
          }
          last = await evaluate(proposal);
          if (!last.issues.length) break;
          previous = proposal.definition_yaml;
          pendingRefinement = undefined;
          errors = issuesForRepair(last.issues);
        }
      } catch (err) {
        await audit('error', { error: err instanceof GatewayError ? err.code : 'internal' });
        throw err;
      } finally {
        clearTimeout(timer);
      }

      const result = last!;
      const valid = Boolean(result.v) && result.issues.length === 0;
      const validation = result.v
        ? {
            valid,
            errors: renderIssues(result.issues, locale),
            warnings: renderIssues(result.v.warnings, locale),
            levels: result.v.levels,
            dependsOn: result.names,
            annotations: result.v.annotations as Record<string, unknown>,
            graph: compositeGraph(result.def!),
          }
        : { valid: false, errors: renderIssues(result.issues, locale), warnings: [], levels: [], dependsOn: [], annotations: {} };
      await audit(valid ? 'valid' : 'invalid', { toolsUsed: result.names, unsupported: result.proposal.unsupported !== null });
      return {
        proposal: {
          source: result.proposal.definition_yaml,
          explanation: result.proposal.explanation,
          assumptions: result.proposal.assumptions,
          unsupported: result.proposal.unsupported,
        },
        validation,
        candidates: [...candidates.values()].map((c) => ({ name: c.tool.name, state: c.tool.state, score: c.score })),
        usage: { provider: provider.provider, model, attempts, ...usage, durationMs: Date.now() - started },
      };
    },
  });

  app.get('/composites/:id/readiness', {
    config: { roles: [ROLE.admin, ROLE.owner] },
    schema: {
      tags: ['composites'],
      summary: 'What is missing to publish the composite: step states, access per role and virtual servers',
      params: uuidParam,
      querystring: readinessQuery,
      response: { 200: compositeReadinessSchema, ...errorResponses },
    },
    handler: async (req) => {
      const tenantId = await resolveTenantId(services, req);
      const principal = requirePrincipal(req);
      const locale = requestLocale(req);
      const comp = await services.repos.composites.get(tenantId, req.params.id);
      if (!comp.toolId) throw new NotFound('composite', comp.id);
      const compTool = await services.repos.tools.get(tenantId, comp.toolId);
      if (!canManageTool(principal, compTool)) throw new Forbidden(msg('admin.compositeNoPermission'));
      const snapshot = await services.registry.get(tenantId);
      const byName = new Map(snapshot.tools.map((t) => [t.name, t]));
      const compName = applyOverrides(compTool).name;

      const steps = (comp.steps as Array<{ id: string; tool: string }>).map((s) => {
        const t = byName.get(s.tool);
        return { id: s.id, tool: s.tool, toolId: t?.id ?? null, state: t?.state ?? null, canManage: t ? canManageTool(principal, t) : false };
      });
      const roles = req.query.roles;
      const targets = [{ name: compName, annotations: compTool.annotations }, ...[...new Set(steps.map((s) => s.tool))].flatMap((n) => {
        const t = byName.get(n);
        return t ? [{ name: t.name, annotations: t.annotations }] : [];
      })];
      const access = targets.flatMap((t) =>
        roles.map((role) => {
          const subject = { sub: `role:${role}`, tenant: snapshot.tenant.slug, roles: [role], groups: [], clientId: 'readiness', claims: {} as never, locale };
          const d = authorize(snapshot, subject, t, 'call');
          return { tool: t.name, role, effect: d.effect, reason: d.reason, explanation: translate(d.explanation, locale) };
        }),
      );
      const vsTool = byName.get(compName) ?? { id: compTool.id, name: compName, kind: 'composite' as const, tags: compTool.tags };
      const virtualServers = (await services.repos.virtualServers.list(tenantId)).map((vs) => ({
        id: vs.id,
        slug: vs.slug,
        name: vs.name,
        canManage: isAdmin(principal) || Boolean(vs.ownerTeam && principal.groups.includes(vs.ownerTeam)),
        includes: matchesSelector(vsTool, vs.toolSelector as ToolSelector),
      }));
      const ready =
        compTool.state === 'enabled' &&
        comp.status === 'valid' &&
        steps.every((s) => s.state === 'enabled') &&
        access.every((a) => a.effect === 'allow');
      return {
        composite: { id: comp.id, toolId: compTool.id, name: compName, state: compTool.state, status: comp.status },
        steps,
        roles,
        access,
        canCreatePolicies: isAdmin(principal),
        virtualServers,
        ready,
      };
    },
  });
};
