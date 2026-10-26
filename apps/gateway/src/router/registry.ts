import type { ToolRouterSettings } from '@mcp-gateway/core';
import { createDecisionModelPlugin, DECISION_MODEL_PLUGIN, type DecisionModelOptions, type DecisionProvider, type ToolRouterPlugin } from '@mcp-gateway/tool-router';

export type RouterPluginFactory = (provider: DecisionProvider, settings: ToolRouterSettings) => ToolRouterPlugin;

/** Tenant settings as the decision-model plugin's options. */
export function decisionModelOptions(s: ToolRouterSettings): DecisionModelOptions {
  const { granularity, minConfidence, mass, maxNamespaces, minTools, maxTools } = s.shortlist;
  return {
    rerank: { minConfidence: s.rerank.minConfidence },
    shortlist: { granularity, minConfidence, mass, maxNamespaces, minTools, maxTools },
    gate: { confirmAt: s.gate.confirmAt, denyAt: s.gate.denyAt },
  };
}

/**
 * Router plugins in consultation order (ADR-025). Rerank and shortlist take the first plugin that
 * does not abstain; the gate takes the most restrictive outcome of all of them.
 */
export class RouterPluginRegistry {
  private readonly factories = new Map<string, RouterPluginFactory>();

  register(name: string, factory: RouterPluginFactory): this {
    this.factories.set(name, factory);
    return this;
  }

  get names(): string[] {
    return [...this.factories.keys()];
  }

  create(provider: DecisionProvider, settings: ToolRouterSettings): ToolRouterPlugin[] {
    return [...this.factories.values()].map((f) => f(provider, settings));
  }

  static withDefaults(): RouterPluginRegistry {
    return new RouterPluginRegistry().register(DECISION_MODEL_PLUGIN, (provider, s) => createDecisionModelPlugin(provider, decisionModelOptions(s)));
  }
}
