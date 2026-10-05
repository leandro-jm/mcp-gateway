import { isSafeRegex } from '@mcp-gateway/core';
import { msg, translate, type ServerMessage } from '@mcp-gateway/i18n/server';
import { z } from 'zod';

/** Time window in which the rule applies (configurable time zone). */
export const timeWindowSchema = z.object({
  days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).optional(),
  start: z.string().regex(/^\d{2}:\d{2}$/).default('00:00'),
  end: z.string().regex(/^\d{2}:\d{2}$/).default('23:59'),
  tz: z.string().default('America/Sao_Paulo'),
});

/**
 * Constraint on arguments. Structured form or a `"<lhs> <op> <rhs>"` expression
 * (e.g. `"args.unidade_id in claims.unidades"`).
 */
export const argConstraintSchema = z.union([
  z.string().min(3),
  z.object({
    path: z.string().describe('Path in args (e.g. unidade_id, filtro.uf)'),
    op: z.enum(['eq', 'neq', 'in', 'not_in', 'lt', 'lte', 'gt', 'gte', 'regex', 'exists', 'not_exists']),
    value: z.unknown().optional(),
    /** Compares against a token claim instead of a literal. */
    claim: z.string().optional(),
  }),
]);

export const conditionsSchema = z
  .object({
    timeWindows: z.array(timeWindowSchema).optional(),
    args: z.array(argConstraintSchema).optional(),
    /** Per-subject call limit for the tools covered by the rule (obligation enforced by the gateway). */
    rate: z.object({ limit: z.number().int().positive(), windowSec: z.number().int().positive().default(60) }).optional(),
  })
  .default({});

export type TimeWindow = z.output<typeof timeWindowSchema>;
export type ArgConstraint = z.output<typeof argConstraintSchema>;
export type Conditions = z.output<typeof conditionsSchema>;

const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } as const;

/** Local date/time in a time zone (no dependencies). */
function localParts(now: Date, tz: string): { day: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const day = DAY_INDEX[(parts.weekday ?? 'Sun').toLowerCase().slice(0, 3) as keyof typeof DAY_INDEX];
  const hour = Number(parts.hour) % 24;
  return { day, minutes: hour * 60 + Number(parts.minute) };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function inTimeWindow(w: TimeWindow, now: Date): boolean {
  const { day, minutes } = localParts(now, w.tz);
  const start = toMinutes(w.start);
  const end = toMinutes(w.end);
  const dayOk = (d: number) => !w.days || w.days.some((name) => DAY_INDEX[name] === d);
  if (start <= end) return dayOk(day) && minutes >= start && minutes <= end;
  // window crossing midnight (e.g. 22:00–06:00): the day is the start day
  if (minutes >= start) return dayOk(day);
  return minutes <= end && dayOk((day + 6) % 7);
}

export function readPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((acc, k) => (acc !== null && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), obj);
}

interface Operand {
  kind: 'args' | 'claims' | 'literal';
  path?: string;
  value?: unknown;
}

function parseOperand(token: string): Operand {
  if (token.startsWith('args.')) return { kind: 'args', path: token.slice(5) };
  if (token.startsWith('claims.')) return { kind: 'claims', path: token.slice(7) };
  try {
    return { kind: 'literal', value: JSON.parse(token) };
  } catch {
    return { kind: 'literal', value: token };
  }
}

const OPS = ['not_in', 'not_exists', 'exists', 'neq', 'lte', 'gte', 'regex', 'eq', 'in', 'lt', 'gt', '==', '!=', '<=', '>=', '<', '>'];
const ALIASES: Record<string, string> = { '==': 'eq', '!=': 'neq', '<=': 'lte', '>=': 'gte', '<': 'lt', '>': 'gt' };

/** Malformed textual constraint. `message` is English (logs); `msg` is rendered in the caller's locale. */
export class ConditionSyntaxError extends Error {
  constructor(readonly msg: ServerMessage) {
    super(translate(msg));
    this.name = 'ConditionSyntaxError';
  }
}

/** Converts the textual form into a structured constraint. */
export function parseConstraint(expr: string): { lhs: Operand; op: string; rhs?: Operand } {
  const m = /^\s*(\S+)\s+(\S+)(?:\s+(.+?))?\s*$/.exec(expr);
  if (!m || !OPS.includes(m[2]!)) throw new ConditionSyntaxError(msg('policy.invalidExpression', { expr }));
  const op = ALIASES[m[2]!] ?? m[2]!;
  const lhs = parseOperand(m[1]!);
  if (op === 'exists' || op === 'not_exists') return { lhs, op };
  if (!m[3]) throw new ConditionSyntaxError(msg('policy.missingRightOperand', { expr }));
  return { lhs, op, rhs: parseOperand(m[3]) };
}

function resolve(o: Operand | undefined, args: unknown, claims: Record<string, unknown>): unknown {
  if (!o) return undefined;
  if (o.kind === 'args') return readPath(args, o.path!);
  if (o.kind === 'claims') return readPath(claims, o.path!);
  return o.value;
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Longest argument value a `regex` constraint will scan. */
const MAX_REGEX_INPUT = 10_000;

/** Numbers, or numeric strings next to a number (`"5000" gt 1000`); undefined = not comparable. */
function numeric(left: unknown, right: unknown): [number, number] | undefined {
  const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  if (typeof left === 'string' && typeof right === 'string') return undefined; // two strings compare as strings
  const l = num(left);
  const r = num(right);
  return l === undefined || r === undefined ? undefined : [l, r];
}

/** `undefined` = the constraint cannot be evaluated (incomparable types, unsafe regex): the caller decides. */
function compare(op: string, left: unknown, right: unknown): boolean | undefined {
  switch (op) {
    case 'eq':
      return eq(left, right);
    case 'neq':
      return !eq(left, right);
    case 'in':
    case 'not_in': {
      const list = Array.isArray(right) ? right : right === undefined ? [] : [right];
      const values = Array.isArray(left) ? left : [left];
      const all = left !== undefined && values.every((v) => list.some((x) => eq(x, v)));
      return op === 'in' ? all : left !== undefined && !values.some((v) => list.some((x) => eq(x, v)));
    }
    case 'lt': {
      if (typeof left === 'string' && typeof right === 'string') return left < right;
      const n = numeric(left, right);
      return n ? n[0] < n[1] : left === undefined || left === null ? false : undefined;
    }
    case 'lte': {
      if (typeof left === 'string' && typeof right === 'string') return left <= right;
      const n = numeric(left, right);
      return n ? n[0] <= n[1] : left === undefined || left === null ? false : undefined;
    }
    case 'gt': {
      if (typeof left === 'string' && typeof right === 'string') return left > right;
      const n = numeric(left, right);
      return n ? n[0] > n[1] : left === undefined || left === null ? false : undefined;
    }
    case 'gte': {
      if (typeof left === 'string' && typeof right === 'string') return left >= right;
      const n = numeric(left, right);
      return n ? n[0] >= n[1] : left === undefined || left === null ? false : undefined;
    }
    case 'regex':
      // the pattern may come from a claim: checked here too, and long inputs are not scanned
      if (left === undefined || left === null) return false;
      if (typeof left !== 'string' || left.length > MAX_REGEX_INPUT || typeof right !== 'string' || !isSafeRegex(right)) return undefined;
      return new RegExp(right).test(left);
    case 'exists':
      return left !== undefined && left !== null;
    case 'not_exists':
      return left === undefined || left === null;
    default:
      return false;
  }
}

/** Evaluates an args constraint; `undefined` when it cannot be evaluated (see `compare`). */
export function evalConstraint(c: ArgConstraint, args: unknown, claims: Record<string, unknown>): boolean | undefined {
  if (typeof c === 'string') {
    const p = parseConstraint(c);
    return compare(p.op, resolve(p.lhs, args, claims), resolve(p.rhs, args, claims));
  }
  const left = readPath(args, c.path);
  const right = c.claim !== undefined ? readPath(claims, c.claim) : c.value;
  return compare(c.op, left, right);
}
