import { buildGateRequest, buildNamespaceChoice, buildToolChoice, namespaceOf } from './builders';
import { interpretChoice, interpretGate, takeByMass, type ChoiceStatus } from './interpret';
import { PROVIDER_LIMITS, type DecisionProvider } from './model';
import type { RouterDecision, RouterReason, ToolRouterPlugin } from './plugin';

export const DECISION_MODEL_PLUGIN = 'decision-model';

export interface DecisionModelOptions {
  rerank: { minConfidence: number };
  shortlist: {
    granularity: 'namespace' | 'tool';
    minConfidence: number;
    /** Cumulative probability of the namespaces (or tools) to keep. */
    mass: number;
    /** Namespaces kept by mass; more are added only to reach `minTools`. */
    maxNamespaces: number;
    minTools: number;
    maxTools: number;
  };
  gate: { confirmAt: number; denyAt: number };
  /** Overrides `PROVIDER_LIMITS[provider].maxChoices`. */
  maxChoices?: number;
}

const reasonOf = (status: ChoiceStatus): RouterReason => status;

/**
 * Default plugin: asks a decision model (OpenAI Decisions or Jev, through `provider`) one
 * question per hook. Provider errors propagate; the router service maps them to fallbacks.
 */
export function createDecisionModelPlugin(provider: DecisionProvider, o: DecisionModelOptions): ToolRouterPlugin {
  const maxChoices = o.maxChoices ?? PROVIDER_LIMITS[provider.id].maxChoices;
  const base = (point: RouterDecision['point']) => ({ plugin: DECISION_MODEL_PLUGIN, point, provider: provider.id, model: provider.model });

  return {
    name: DECISION_MODEL_PLUGIN,

    async rerank(ctx, input) {
      const { request, optionToName } = buildToolChoice({ query: input.query, candidates: input.candidates, maxChoices });
      const res = await provider.decide(request, ctx.signal);
      const out = interpretChoice(res.answers.tool, optionToName, { minConfidence: o.rerank.minConfidence });
      const decision: RouterDecision = {
        ...base('rerank'),
        decision: out.status === 'ok' ? 'applied' : 'skipped',
        reason: reasonOf(out.status),
        candidates: optionToName.size,
        kept: out.ranked.length,
        ...(out.confidence ? { confidence: out.confidence } : {}),
      };
      return out.status === 'ok' ? { value: out.ranked, decision } : { decision };
    },

    async shortlist(ctx, input) {
      const s = o.shortlist;
      if (s.granularity === 'tool') {
        const { request, optionToName } = buildToolChoice({ query: input.intent, candidates: input.tools, maxChoices });
        const res = await provider.decide(request, ctx.signal);
        const out = interpretChoice(res.answers.tool, optionToName, { minConfidence: s.minConfidence });
        const decision: RouterDecision = { ...base('shortlist'), decision: 'skipped', reason: reasonOf(out.status), candidates: optionToName.size, ...(out.confidence ? { confidence: out.confidence } : {}) };
        if (out.status !== 'ok') return { decision };
        // Mass decides the head; the remaining candidates (search order) fill up to `minTools`.
        const head = takeByMass(out.ranked, out.weights, s.mass, s.maxTools);
        const fill = [...optionToName.values()].filter((n) => !head.includes(n));
        const names = [...head, ...fill.slice(0, Math.max(0, s.minTools - head.length))].slice(0, s.maxTools);
        return { value: names, decision: { ...decision, decision: 'applied', kept: names.length } };
      }

      const built = buildNamespaceChoice({ intent: input.intent, tools: input.tools, maxChoices });
      if (!built) return { decision: { ...base('shortlist'), decision: 'skipped', reason: 'too_many', candidates: input.tools.length } };
      const res = await provider.decide(built.request, ctx.signal);
      const out = interpretChoice(res.answers.namespace, built.optionToNamespace, { minConfidence: s.minConfidence });
      const decision: RouterDecision = { ...base('shortlist'), decision: 'skipped', reason: reasonOf(out.status), candidates: built.optionToNamespace.size, ...(out.confidence ? { confidence: out.confidence } : {}) };
      if (out.status !== 'ok') return { decision };

      const chosen = takeByMass(out.ranked, out.weights, s.mass, s.maxNamespaces);
      const size = (ns: string[]) => ns.reduce((n, x) => n + (built.byNamespace.get(x)?.length ?? 0), 0);
      // Too few tools: add the next namespaces in probability order, then any namespace, until `minTools`.
      const rest = [...out.ranked, ...built.byNamespace.keys()].filter((ns, i, all) => !chosen.includes(ns) && all.indexOf(ns) === i);
      while (size(chosen) < s.minTools && rest.length) chosen.push(rest.shift()!);
      const rank = new Map(chosen.map((ns, i) => [ns, i]));
      const names = input.tools
        .filter((t) => rank.has(namespaceOf(t)))
        .sort((a, b) => rank.get(namespaceOf(a))! - rank.get(namespaceOf(b))!)
        .slice(0, s.maxTools)
        .map((t) => t.name);
      return { value: names, decision: { ...decision, decision: 'applied', kept: names.length } };
    },

    async gate(ctx, input) {
      const res = await provider.decide(buildGateRequest(input), ctx.signal);
      const g = interpretGate(res, o.gate);
      const decision: RouterDecision = { ...base('gate'), decision: g.outcome ?? 'allow', reason: g.reason, ...(g.confidence ? { confidence: g.confidence } : {}) };
      return g.outcome ? { value: g.outcome, decision } : { decision };
    },
  };
}
