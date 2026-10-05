import { msg, translate } from '@mcp-gateway/i18n/server';
import { describe, expect, it } from 'vitest';
import { ConditionSyntaxError, inTimeWindow, parseConstraint } from './conditions';
import { evaluate, type EvalInput, type PolicyRule, type Subject, type ToolRef } from './engine';

const agent: Subject = { sub: 'u-1', clientId: 'agent-dev', roles: ['agent'], groups: ['team-rh'], claims: { unidades: ['uni-1', 'uni-2'], nivel: 3 } };
const other: Subject = { sub: 'u-2', clientId: 'other-client', roles: ['viewer'], groups: [], claims: {} };

const T = {
  list: { name: 'rh_colaboradores_list', annotations: { readOnlyHint: true } },
  get: { name: 'rh_colaborador_get', annotations: { readOnlyHint: true } },
  create: { name: 'rh_marcacao_create', annotations: { readOnlyHint: false } },
  del: { name: 'rh_marcacao_delete', annotations: { readOnlyHint: false, destructiveHint: true } },
  fin: { name: 'fin_pagamentos_list', annotations: { readOnlyHint: true } },
} satisfies Record<string, ToolRef>;

let n = 0;
const r = (p: Omit<PolicyRule, 'id'> & { id?: string }): PolicyRule => ({ id: p.id ?? `r${++n}`, ...p });

// Monday 10:00 in São Paulo = 13:00 UTC; Sunday 23:30 in SP = Monday 02:30 UTC.
const MON_10 = new Date('2026-10-05T13:00:00Z');
const SUN_2330 = new Date('2026-10-05T02:30:00Z');

interface Case {
  name: string;
  rules: PolicyRule[];
  input: Partial<EvalInput> & { tool: ToolRef };
  effect: 'allow' | 'deny';
  reason?: string;
  ruleId?: string;
}

const cases: Case[] = [
  // ---- default deny and basic allow
  { name: 'no rules → default deny', rules: [], input: { tool: T.list }, effect: 'deny', reason: 'default_deny' },
  { name: 'allow by role and exact name', rules: [r({ id: 'a', subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_colaboradores_list' })], input: { tool: T.list }, effect: 'allow', ruleId: 'a' },
  { name: 'allow by role with glob', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*' })], input: { tool: T.get }, effect: 'allow' },
  { name: 'glob of another source does not cover', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*' })], input: { tool: T.fin }, effect: 'deny', reason: 'default_deny' },
  { name: 'role the subject does not have', rules: [r({ subjectType: 'role', subject: 'gateway-admin', effect: 'allow', toolPattern: '*' })], input: { tool: T.list }, effect: 'deny' },
  { name: 'allow by client', rules: [r({ subjectType: 'client', subject: 'agent-dev', effect: 'allow', toolPattern: 'rh_*' })], input: { tool: T.list }, effect: 'allow' },
  { name: 'allow by client does not apply to another client', rules: [r({ subjectType: 'client', subject: 'agent-dev', effect: 'allow', toolPattern: 'rh_*' })], input: { tool: T.list, subject: other }, effect: 'deny' },
  { name: 'allow by user', rules: [r({ subjectType: 'user', subject: 'u-1', effect: 'allow', toolPattern: 'rh_colaborador_get' })], input: { tool: T.get }, effect: 'allow' },
  { name: 'allow by group', rules: [r({ subjectType: 'group', subject: 'team-rh', effect: 'allow', toolPattern: 'rh_*' })], input: { tool: T.list }, effect: 'allow' },
  { name: 'allow with role wildcard subject', rules: [r({ subjectType: 'role', subject: '*', effect: 'allow', toolPattern: 'rh_colaboradores_list' })], input: { tool: T.list, subject: other }, effect: 'allow' },
  { name: 'user wildcard applies to any user', rules: [r({ subjectType: 'user', subject: '*', effect: 'allow', toolPattern: 'rh_colaboradores_list' })], input: { tool: T.list, subject: other }, effect: 'allow' },
  // ---- annotation selector
  { name: 'annotation:readOnlyHint covers reads', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'annotation:readOnlyHint' })], input: { tool: T.fin }, effect: 'allow' },
  { name: 'annotation:readOnlyHint does not cover writes', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'annotation:readOnlyHint' })], input: { tool: T.create }, effect: 'deny' },
  // ---- deny wins
  { name: 'explicit deny beats allow', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*' }), r({ id: 'd', subjectType: 'role', subject: 'agent', effect: 'deny', toolPattern: 'rh_colaborador_get' })], input: { tool: T.get }, effect: 'deny', reason: 'explicit_deny', ruleId: 'd' },
  { name: 'generic deny beats specific allow', rules: [r({ subjectType: 'user', subject: 'u-1', effect: 'allow', toolPattern: 'rh_colaborador_get' }), r({ subjectType: 'role', subject: 'agent', effect: 'deny', toolPattern: '*' })], input: { tool: T.get }, effect: 'deny', reason: 'explicit_deny' },
  { name: 'deny for another subject has no effect', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*' }), r({ subjectType: 'client', subject: 'other-client', effect: 'deny', toolPattern: '*' })], input: { tool: T.get }, effect: 'allow' },
  { name: 'deny by annotation on a write tool', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*' }), r({ subjectType: 'group', subject: 'team-rh', effect: 'deny', toolPattern: 'annotation:destructiveHint' })], input: { tool: T.del }, effect: 'deny', reason: 'explicit_deny' },
  // ---- specificity (reported rule)
  { name: 'reports the most specific rule', rules: [r({ id: 'gen', subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*' }), r({ id: 'spec', subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_colaboradores_list' })], input: { tool: T.list }, effect: 'allow', ruleId: 'spec' },
  { name: 'user is more specific than role on the same pattern', rules: [r({ id: 'role', subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*' }), r({ id: 'user', subjectType: 'user', subject: 'u-1', effect: 'allow', toolPattern: 'rh_*' })], input: { tool: T.list }, effect: 'allow', ruleId: 'user' },
  // ---- destructive tools
  { name: 'allow * does not cover destructive', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: '*' })], input: { tool: T.del }, effect: 'deny', reason: 'destructive_requires_explicit_allow' },
  { name: 'allow * covers non-destructive write', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: '*' })], input: { tool: T.create }, effect: 'allow' },
  { name: 'allow by name covers destructive', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_marcacao_delete' })], input: { tool: T.del }, effect: 'allow' },
  { name: 'allow by pattern covers destructive', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_marcacao_*' })], input: { tool: T.del }, effect: 'allow' },
  { name: 'allow annotation:readOnlyHint does not cover destructive', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'annotation:readOnlyHint' })], input: { tool: T.del }, effect: 'deny' },
  { name: 'allow * + allow by name → destructive allowed', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: '*' }), r({ id: 'byname', subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_marcacao_delete' })], input: { tool: T.del }, effect: 'allow', ruleId: 'byname' },
  // ---- time conditions
  { name: 'allow inside the window', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*', conditions: { timeWindows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00', end: '18:00' }] } })], input: { tool: T.list, now: MON_10 }, effect: 'allow' },
  { name: 'allow outside the window', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*', conditions: { timeWindows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00', end: '18:00' }] } })], input: { tool: T.list, now: SUN_2330 }, effect: 'deny', reason: 'conditions_not_met' },
  { name: 'deny only inside the window (outside → allow applies)', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*' }), r({ subjectType: 'role', subject: 'agent', effect: 'deny', toolPattern: 'rh_*', conditions: { timeWindows: [{ start: '22:00', end: '06:00' }] } })], input: { tool: T.list, now: MON_10 }, effect: 'allow' },
  { name: 'night deny crossing midnight', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*' }), r({ subjectType: 'role', subject: 'agent', effect: 'deny', toolPattern: 'rh_*', conditions: { timeWindows: [{ start: '22:00', end: '06:00' }] } })], input: { tool: T.list, now: SUN_2330 }, effect: 'deny', reason: 'explicit_deny' },
  // ---- args conditions
  { name: 'args in claims: allowed value', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*', conditions: { args: ['args.unidade_id in claims.unidades'] } })], input: { tool: T.list, mode: 'call', args: { unidade_id: 'uni-2' } }, effect: 'allow' },
  { name: 'args in claims: value not in list', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*', conditions: { args: ['args.unidade_id in claims.unidades'] } })], input: { tool: T.list, mode: 'call', args: { unidade_id: 'uni-9' } }, effect: 'deny', reason: 'conditions_not_met' },
  { name: 'args in claims: missing argument', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*', conditions: { args: ['args.unidade_id in claims.unidades'] } })], input: { tool: T.list, mode: 'call', args: {} }, effect: 'deny' },
  { name: 'args constraint in list mode: tool visible', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*', conditions: { args: ['args.unidade_id in claims.unidades'] } })], input: { tool: T.list, mode: 'list' }, effect: 'allow' },
  { name: 'args-conditioned deny does not hide in list', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*' }), r({ subjectType: 'role', subject: 'agent', effect: 'deny', toolPattern: 'rh_*', conditions: { args: [{ path: 'size', op: 'gt', value: 100 }] } })], input: { tool: T.list, mode: 'list' }, effect: 'allow' },
  { name: 'args-conditioned deny applies on call', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*' }), r({ subjectType: 'role', subject: 'agent', effect: 'deny', toolPattern: 'rh_*', conditions: { args: [{ path: 'size', op: 'gt', value: 100 }] } })], input: { tool: T.list, mode: 'call', args: { size: 500 } }, effect: 'deny', reason: 'explicit_deny' },
  { name: 'args-conditioned deny does not apply below the limit', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*' }), r({ subjectType: 'role', subject: 'agent', effect: 'deny', toolPattern: 'rh_*', conditions: { args: [{ path: 'size', op: 'gt', value: 100 }] } })], input: { tool: T.list, mode: 'call', args: { size: 10 } }, effect: 'allow' },
  { name: 'structured constraint with claim', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*', conditions: { args: [{ path: 'filtro.unidade', op: 'in', claim: 'unidades' }] } })], input: { tool: T.list, mode: 'call', args: { filtro: { unidade: 'uni-1' } } }, effect: 'allow' },
  { name: 'regex on argument', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*', conditions: { args: ['args.id regex "^col-\\\\d+$"'] } })], input: { tool: T.get, mode: 'call', args: { id: 'col-00001' } }, effect: 'allow' },
  { name: 'unsafe regex never matches (ReDoS)', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*', conditions: { args: ['args.id regex "(a+)+$"'] } })], input: { tool: T.get, mode: 'call', args: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!' } }, effect: 'deny' },
  { name: 'regex from a claim is checked at runtime', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*', conditions: { args: [{ path: 'id', op: 'regex', claim: 're' }] } })], input: { tool: T.get, mode: 'call', args: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!' }, subject: { ...agent, claims: { re: '(a|aa)+$' } } }, effect: 'deny' },
  { name: 'safe regex from a claim matches', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*', conditions: { args: [{ path: 'id', op: 'regex', claim: 're' }] } })], input: { tool: T.get, mode: 'call', args: { id: 'col-7' }, subject: { ...agent, claims: { re: '^col-\\d+$' } } }, effect: 'allow' },
  { name: 'deny compares a numeric string as a number', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*' }), r({ subjectType: 'role', subject: 'agent', effect: 'deny', toolPattern: 'rh_*', conditions: { args: ['args.size gt 100'] } })], input: { tool: T.list, mode: 'call', args: { size: '5000' } }, effect: 'deny', reason: 'explicit_deny' },
  { name: 'deny that cannot be evaluated applies (fail closed)', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*' }), r({ subjectType: 'role', subject: 'agent', effect: 'deny', toolPattern: 'rh_*', conditions: { args: ['args.size gt 100'] } })], input: { tool: T.list, mode: 'call', args: { size: { $gt: 0 } } }, effect: 'deny', reason: 'explicit_deny' },
  { name: 'deny with an invalid time zone applies (fail closed)', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*' }), r({ subjectType: 'role', subject: 'agent', effect: 'deny', toolPattern: 'rh_*', conditions: { timeWindows: [{ tz: 'Mars/Olympus' }] } })], input: { tool: T.list }, effect: 'deny', reason: 'explicit_deny' },
  { name: 'deny with unreadable conditions applies (fail closed)', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*' }), r({ subjectType: 'role', subject: 'agent', effect: 'deny', toolPattern: 'rh_*', conditions: { timeWindows: [{ start: '25h' }] } })], input: { tool: T.list }, effect: 'deny', reason: 'explicit_deny' },
  { name: 'generic patterns do not cover destructive tools', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: '*_*' }), r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: '?*' }), r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'r*' }), r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh*' })], input: { tool: T.del }, effect: 'deny' },
  { name: 'a pattern naming the destructive verb covers it', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: '*_delete' })], input: { tool: T.del }, effect: 'allow' },
  { name: 'args array must be fully contained', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*', conditions: { args: ['args.unidades in claims.unidades'] } })], input: { tool: T.list, mode: 'call', args: { unidades: ['uni-1', 'uni-3'] } }, effect: 'deny' },
  { name: 'numeric comparison with literal', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*', conditions: { args: ['args.size lte 50'] } })], input: { tool: T.list, mode: 'call', args: { size: 50 } }, effect: 'allow' },
  { name: 'invalid condition ignores the rule', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*', conditions: { timeWindows: [{ start: '25h' }] } })], input: { tool: T.list }, effect: 'deny', reason: 'default_deny' },
  { name: 'malformed expression denies (fail closed)', rules: [r({ subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*', conditions: { args: ['args.x foo bar'] } })], input: { tool: T.list, mode: 'call', args: { x: 1 } }, effect: 'deny' },
];

describe('policy engine (case table)', () => {
  it('has at least 30 cases', () => expect(cases.length).toBeGreaterThanOrEqual(30));

  it.each(cases)('$name', (c) => {
    const d = evaluate(c.rules, { subject: agent, mode: 'call', now: MON_10, ...c.input } as EvalInput);
    expect(d.effect).toBe(c.effect);
    if (c.reason) expect(d.reason).toBe(c.reason);
    if (c.ruleId) expect(d.ruleId).toBe(c.ruleId);
    expect(translate(d.explanation).length).toBeGreaterThan(0);
  });
});

describe('details', () => {
  it('rate limit obligations of applicable rules', () => {
    const d = evaluate(
      [r({ id: 'lim', subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*', conditions: { rate: { limit: 10 } } })],
      { subject: agent, tool: T.list, mode: 'call', args: {} },
    );
    expect(d.obligations.rateLimits).toEqual([{ ruleId: 'lim', limit: 10, windowSec: 60 }]);
  });

  it('trace explains evaluated rules', () => {
    const d = evaluate(
      [r({ id: 'x', subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: '*' })],
      { subject: agent, tool: T.del, mode: 'call' },
    );
    expect(d.trace).toEqual([{ ruleId: 'x', effect: 'allow', matched: false, note: msg('policy.genericAllowSkipsDestructive') }]);
  });

  it('expression parser', () => {
    expect(parseConstraint('args.a == 1')).toMatchObject({ op: 'eq', rhs: { kind: 'literal', value: 1 } });
    expect(parseConstraint('args.a exists')).toMatchObject({ op: 'exists' });
    expect(() => parseConstraint('args.a')).toThrow(ConditionSyntaxError);
    try {
      parseConstraint('args.a foo');
    } catch (err) {
      expect((err as ConditionSyntaxError).msg).toEqual(msg('policy.invalidExpression', { expr: 'args.a foo' }));
      expect((err as Error).message).toBe('invalid expression: args.a foo');
    }
  });

  it('time window with time zone', () => {
    expect(inTimeWindow({ start: '09:00', end: '11:00', tz: 'America/Sao_Paulo' }, MON_10)).toBe(true);
    expect(inTimeWindow({ start: '09:00', end: '11:00', tz: 'UTC' }, MON_10)).toBe(false);
  });
});

describe('localized explanations', () => {
  it('default deny explanation is a Message', () => {
    const d = evaluate([], { subject: agent, tool: T.list, mode: 'call' });
    expect(d.explanation).toEqual(msg('policy.defaultDeny'));
    expect(translate(d.explanation, 'pt-BR')).toBe('nenhuma regra permite esta tool (default deny)');
  });

  it('explicit deny renders params in every locale', () => {
    const d = evaluate([r({ id: 'd1', subjectType: 'role', subject: 'agent', effect: 'deny', toolPattern: 'rh_*' })], { subject: agent, tool: T.list, mode: 'call' });
    expect(translate(d.explanation)).toBe('denied by rule d1 (role:agent → rh_*)');
    expect(translate(d.explanation, 'es')).toBe('denegado por la regla d1 (role:agent → rh_*)');
  });
});
