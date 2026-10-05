import { evaluate, type Decision, type EvalMode, type PolicyRule, type Subject } from '@mcp-gateway/policy';
import type { RegistrySnapshot, SnapshotTool } from '../registry/snapshot';
import type { Principal } from './tokens';

export function subjectOf(p: Principal): Subject {
  return { sub: p.sub, clientId: p.clientId, roles: p.roles, groups: p.groups, claims: p.claims };
}

export function rulesOf(snapshot: RegistrySnapshot): PolicyRule[] {
  return snapshot.policies.map((p) => ({
    id: p.id,
    subjectType: p.subjectType,
    subject: p.subject,
    effect: p.effect,
    toolPattern: p.toolPattern,
    conditions: p.conditions,
    priority: p.priority,
    description: p.description,
  }));
}

/** Authorization decision for (subject, tool) with the policies of the tenant snapshot. */
export function authorize(
  snapshot: RegistrySnapshot,
  principal: Principal,
  tool: Pick<SnapshotTool, 'name' | 'annotations'>,
  mode: EvalMode,
  args?: Record<string, unknown>,
): Decision {
  return evaluate(rulesOf(snapshot), {
    subject: subjectOf(principal),
    tool: { name: tool.name, annotations: tool.annotations },
    mode,
    ...(args ? { args } : {}),
  });
}
