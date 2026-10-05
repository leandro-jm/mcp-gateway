import { globMatch, globSpecificity, type ToolAnnotations } from '@mcp-gateway/core';
import { msg, type ServerMessage } from '@mcp-gateway/i18n/server';
import { conditionsSchema, evalConstraint, inTimeWindow, type Conditions } from './conditions';

export type SubjectType = 'role' | 'client' | 'user' | 'group';
export type Effect = 'allow' | 'deny';

export interface PolicyRule {
  id: string;
  subjectType: SubjectType;
  /** Subject value; `*` matches any subject of the type. */
  subject: string;
  effect: Effect;
  /** Glob over the name (`rh_colaboradores_*`) or an `annotation:<hint>` selector (e.g. `annotation:readOnlyHint`). */
  toolPattern: string;
  conditions?: unknown;
  priority?: number;
  description?: string | null;
}

export interface Subject {
  sub: string;
  clientId?: string | undefined;
  roles: string[];
  groups: string[];
  claims: Record<string, unknown>;
}

export interface ToolRef {
  name: string;
  annotations: ToolAnnotations;
}

export type EvalMode = 'list' | 'call';

export interface EvalInput {
  subject: Subject;
  tool: ToolRef;
  /** In `call`, arguments are evaluated; in `list`, args constraints cannot be decided. */
  mode: EvalMode;
  args?: Record<string, unknown>;
  now?: Date;
}

export type DecisionReason =
  | 'allow'
  | 'default_deny'
  | 'explicit_deny'
  | 'destructive_requires_explicit_allow'
  | 'conditions_not_met';

export interface RateObligation {
  ruleId: string;
  limit: number;
  windowSec: number;
}

export interface RuleTrace {
  ruleId: string;
  effect: Effect;
  matched: boolean;
  note: ServerMessage;
}

export interface Decision {
  effect: Effect;
  reason: DecisionReason;
  /** Deciding rule (absent on default deny). */
  ruleId?: string;
  /** Human explanation, rendered by the caller in the user's locale (ADR-012). */
  explanation: ServerMessage;
  obligations: { rateLimits: RateObligation[] };
  trace: RuleTrace[];
}

function subjectMatches(rule: PolicyRule, s: Subject): boolean {
  const any = rule.subject === '*';
  switch (rule.subjectType) {
    case 'role':
      return any ? s.roles.length > 0 : s.roles.includes(rule.subject);
    case 'group':
      return any ? s.groups.length > 0 : s.groups.includes(rule.subject);
    case 'client':
      return s.clientId !== undefined && (any || s.clientId === rule.subject);
    case 'user':
      return any || s.sub === rule.subject;
  }
}

const ANNOTATION_PREFIX = 'annotation:';

function toolMatches(pattern: string, tool: ToolRef): boolean {
  if (pattern.startsWith(ANNOTATION_PREFIX)) {
    const hint = pattern.slice(ANNOTATION_PREFIX.length) as keyof ToolAnnotations;
    return tool.annotations[hint] === true;
  }
  return globMatch(pattern, tool.name);
}

/**
 * An allow only covers a destructive tool if it names the tool or uses its own pattern, with
 * enough literal text to say what it targets (`rh_marcacao_*`, `*_delete`), never a generic
 * one (`*`, `*_*`, `?*`, `a*`).
 */
function coversDestructive(pattern: string): boolean {
  if (pattern.startsWith(ANNOTATION_PREFIX)) return pattern === `${ANNOTATION_PREFIX}destructiveHint`;
  return pattern.replace(/[*?]/g, '').length >= MIN_DESTRUCTIVE_LITERALS;
}

const MIN_DESTRUCTIVE_LITERALS = 3;

function specificity(rule: PolicyRule): number {
  const subjectWeight = { user: 400, client: 300, group: 200, role: 100 }[rule.subjectType] - (rule.subject === '*' ? 50 : 0);
  const toolWeight = rule.toolPattern.startsWith(ANNOTATION_PREFIX) ? 1 : globSpecificity(rule.toolPattern);
  return toolWeight * 1000 + subjectWeight;
}

type ConditionResult = 'met' | 'not_met' | 'unknown';

/**
 * Fails closed: a condition that cannot be evaluated (incomparable types, invalid time zone,
 * unsafe regex) keeps an allow from applying and makes a deny apply.
 */
function checkConditions(c: Conditions, input: EvalInput, effect: PolicyRule['effect']): { result: ConditionResult; note: ServerMessage } {
  const now = input.now ?? new Date();
  const undecided = effect === 'deny';
  if (c.timeWindows?.length) {
    let inside: boolean;
    try {
      inside = c.timeWindows.some((w) => inTimeWindow(w, now));
    } catch {
      inside = undecided;
    }
    if (!inside) return { result: 'not_met', note: msg('policy.outsideTimeWindow') };
  }
  if (c.args?.length) {
    if (input.mode === 'list' || !input.args) return { result: 'unknown', note: msg('policy.argsCheckedOnCall') };
    for (const constraint of c.args) {
      let ok: boolean;
      try {
        ok = evalConstraint(constraint, input.args, input.subject.claims) ?? undecided;
      } catch {
        ok = undecided;
      }
      if (!ok) {
        return { result: 'not_met', note: msg('policy.constraintNotMet', { constraint: typeof constraint === 'string' ? constraint : JSON.stringify(constraint) }) };
      }
    }
  }
  return { result: 'met', note: msg('policy.conditionsMet') };
}

/**
 * Evaluates the tenant policies for (subject, tool, args):
 * 1. default deny;
 * 2. an applicable explicit `deny` beats any `allow`;
 * 3. an applicable `allow` grants access (the most specific rule is reported);
 * 4. tools with `destructiveHint` require an explicit allow by name or pattern (`*` does not cover them);
 * 5. conditions: time window and args constraints. In `list`, args constraints stay
 *    pending: a conditional allow shows the tool, a conditional deny does not hide it.
 */
export function evaluate(rules: PolicyRule[], input: EvalInput): Decision {
  const trace: RuleTrace[] = [];
  const destructive = input.tool.annotations.destructiveHint === true;
  const allows: Array<{ rule: PolicyRule; conditions: Conditions }> = [];
  const denies: Array<{ rule: PolicyRule; conditions: Conditions }> = [];
  let blockedByDestructive = false;
  let blockedByConditions: ServerMessage | undefined;

  const ordered = [...rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || specificity(b) - specificity(a));
  for (const rule of ordered) {
    if (!subjectMatches(rule, input.subject)) continue;
    if (!toolMatches(rule.toolPattern, input.tool)) continue;
    const parsed = conditionsSchema.safeParse(rule.conditions ?? {});
    if (!parsed.success) {
      // fail closed: an unreadable deny still denies; an unreadable allow grants nothing
      const applies = rule.effect === 'deny';
      trace.push({ ruleId: rule.id, effect: rule.effect, matched: applies, note: msg('policy.invalidConditions') });
      if (applies) denies.push({ rule, conditions: {} });
      continue;
    }
    const cond = checkConditions(parsed.data, input, rule.effect);
    if (rule.effect === 'deny') {
      // a deny conditioned on args does not hide the tool in list mode
      const applies = cond.result === 'met';
      trace.push({ ruleId: rule.id, effect: 'deny', matched: applies, note: cond.note });
      if (applies) denies.push({ rule, conditions: parsed.data });
      continue;
    }
    if (destructive && !coversDestructive(rule.toolPattern)) {
      trace.push({ ruleId: rule.id, effect: 'allow', matched: false, note: msg('policy.genericAllowSkipsDestructive') });
      blockedByDestructive = true;
      continue;
    }
    if (cond.result === 'not_met') {
      trace.push({ ruleId: rule.id, effect: 'allow', matched: false, note: cond.note });
      blockedByConditions ??= cond.note;
      continue;
    }
    trace.push({ ruleId: rule.id, effect: 'allow', matched: true, note: cond.note });
    allows.push({ rule, conditions: parsed.data });
  }

  const none = { rateLimits: [] as RateObligation[] };
  if (denies.length) {
    const d = denies[0]!.rule;
    return {
      effect: 'deny',
      reason: 'explicit_deny',
      ruleId: d.id,
      explanation: msg('policy.explicitDeny', { rule: d.id, subjectType: d.subjectType, subject: d.subject, pattern: d.toolPattern }),
      obligations: none,
      trace,
    };
  }
  if (allows.length) {
    const best = [...allows].sort((a, b) => specificity(b.rule) - specificity(a.rule))[0]!.rule;
    const rateLimits = allows
      .filter((a) => a.conditions.rate)
      .map((a) => ({ ruleId: a.rule.id, limit: a.conditions.rate!.limit, windowSec: a.conditions.rate!.windowSec }));
    return {
      effect: 'allow',
      reason: 'allow',
      ruleId: best.id,
      explanation: msg('policy.allowedByRule', { rule: best.id, subjectType: best.subjectType, subject: best.subject, pattern: best.toolPattern }),
      obligations: { rateLimits },
      trace,
    };
  }
  if (blockedByDestructive) {
    return {
      effect: 'deny',
      reason: 'destructive_requires_explicit_allow',
      explanation: msg('policy.destructiveRequiresExplicitAllow', { tool: input.tool.name }),
      obligations: none,
      trace,
    };
  }
  if (blockedByConditions) {
    return { effect: 'deny', reason: 'conditions_not_met', explanation: blockedByConditions, obligations: none, trace };
  }
  return { effect: 'deny', reason: 'default_deny', explanation: msg('policy.defaultDeny'), obligations: none, trace };
}
