import { shortHash } from '../hash';

/**
 * Agent analytics (F15.20, ADR-016 §15): what an APM does not see, from the sequence of calls in
 * each session. Pure functions over call events read back from the store.
 */
export interface TrajectoryEvent {
  ts: Date;
  callId: string;
  sessionKey: string;
  subject: string;
  agentName?: string | null;
  kind: string;
  toolName: string;
  decision: string;
  errorCode?: string | null;
  errorStage?: string | null;
  argsHash?: string | null;
  meta?: { results?: string[] } | null;
}

export interface Session {
  /** `sessionKey#n`: a session key split by idle gaps. */
  id: string;
  sessionKey: string;
  subject: string;
  agentName: string | null;
  start: Date;
  end: Date;
  events: TrajectoryEvent[];
}

export type FindingType = 'loop' | 'thrash' | 'search_miss' | 'abandoned';

export interface Finding {
  type: FindingType;
  sessionId: string;
  sessionKey: string;
  subject: string;
  agentName: string | null;
  tool: string;
  /** Other tools involved (thrash) or what the search returned (search_miss). */
  related?: string[];
  count: number;
  detail?: string;
  firstCallId: string;
  lastCallId: string;
  at: Date;
}

export const SESSION_GAP_MS = 30 * 60_000;

const isCall = (e: TrajectoryEvent) => e.kind === 'tool';
const ok = (e: TrajectoryEvent) => e.decision === 'allow';

/** Groups events by session key and splits a key where the agent was idle for longer than `gapMs`. */
export function sessionize(events: TrajectoryEvent[], gapMs = SESSION_GAP_MS): Session[] {
  const byKey = new Map<string, TrajectoryEvent[]>();
  for (const e of events) {
    if (!e.sessionKey) continue;
    const list = byKey.get(e.sessionKey) ?? [];
    list.push(e);
    byKey.set(e.sessionKey, list);
  }
  const out: Session[] = [];
  for (const [key, list] of byKey) {
    list.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    let current: TrajectoryEvent[] = [];
    let n = 0;
    const flush = () => {
      if (!current.length) return;
      out.push({
        id: `${key}#${n++}`,
        sessionKey: key,
        subject: current[0]!.subject,
        agentName: current.find((e) => e.agentName)?.agentName ?? null,
        start: current[0]!.ts,
        end: current[current.length - 1]!.ts,
        events: current,
      });
      current = [];
    };
    for (const e of list) {
      const last = current[current.length - 1];
      if (last && e.ts.getTime() - last.ts.getTime() > gapMs) flush();
      current.push(e);
    }
    flush();
  }
  return out;
}

const finding = (s: Session, type: FindingType, tool: string, events: TrajectoryEvent[], extra: Partial<Finding> = {}): Finding => ({
  type,
  sessionId: s.id,
  sessionKey: s.sessionKey,
  subject: s.subject,
  agentName: s.agentName,
  tool,
  count: events.length,
  firstCallId: events[0]!.callId,
  lastCallId: events[events.length - 1]!.callId,
  at: events[events.length - 1]!.ts,
  ...extra,
});

/** The same tool with the same arguments, again and again in a short window. */
export function detectLoops(s: Session, opts: { minRepeats?: number; windowMs?: number } = {}): Finding[] {
  const minRepeats = opts.minRepeats ?? 3;
  const windowMs = opts.windowMs ?? 5 * 60_000;
  const groups = new Map<string, TrajectoryEvent[]>();
  for (const e of s.events.filter(isCall)) {
    if (!e.argsHash) continue;
    const k = `${e.toolName}:${e.argsHash}`;
    const list = groups.get(k) ?? [];
    list.push(e);
    groups.set(k, list);
  }
  const out: Finding[] = [];
  for (const list of groups.values()) {
    // largest burst inside the window
    let best: TrajectoryEvent[] = [];
    let i = 0;
    for (let j = 0; j < list.length; j++) {
      while (list[j]!.ts.getTime() - list[i]!.ts.getTime() > windowMs) i++;
      if (j - i + 1 > best.length) best = list.slice(i, j + 1);
    }
    if (best.length >= minRepeats) out.push(finding(s, 'loop', best[0]!.toolName, best));
  }
  return out;
}

/** Alternating between two or three tools without progress (no successful call in the run). */
export function detectThrash(s: Session, opts: { minSwitches?: number; maxTools?: number } = {}): Finding[] {
  const minSwitches = opts.minSwitches ?? 5;
  const maxTools = opts.maxTools ?? 3;
  const calls = s.events.filter(isCall);
  const out: Finding[] = [];
  let start = 0;
  while (start < calls.length) {
    const tools = new Set<string>();
    let switches = 0;
    let end = start;
    for (; end < calls.length; end++) {
      const e = calls[end]!;
      if (ok(e)) break;
      tools.add(e.toolName);
      if (tools.size > maxTools) break;
      if (end > start && calls[end - 1]!.toolName !== e.toolName) switches++;
    }
    const run = calls.slice(start, end);
    if (switches >= minSwitches && tools.size >= 2) {
      const [first, ...rest] = [...new Set(run.map((e) => e.toolName))];
      out.push(finding(s, 'thrash', first!, run, { related: rest, detail: `${switches} switches` }));
    }
    start = Math.max(end, start + 1);
  }
  return out;
}

/**
 * `search_tools` followed by a wrong choice: the agent called a tool the search did not return,
 * the chosen tool failed validation, or it searched again without a successful call in between.
 */
export function searchMisses(s: Session, opts: { withinMs?: number } = {}): Finding[] {
  const withinMs = opts.withinMs ?? 60_000;
  const out: Finding[] = [];
  const events = s.events;
  for (let i = 0; i < events.length; i++) {
    const search = events[i]!;
    if (search.kind !== 'meta' || search.toolName !== 'search_tools') continue;
    const results = search.meta?.results ?? [];
    for (let j = i + 1; j < events.length; j++) {
      const e = events[j]!;
      if (e.ts.getTime() - search.ts.getTime() > withinMs) break;
      if (e.kind === 'meta' && e.toolName === 'search_tools') {
        out.push(finding(s, 'search_miss', search.toolName, [search, e], { related: results, detail: 're_search' }));
        break;
      }
      if (!isCall(e)) continue;
      if (!results.includes(e.toolName)) out.push(finding(s, 'search_miss', e.toolName, [search, e], { related: results, detail: 'not_in_results' }));
      else if (e.errorStage === 'validation') out.push(finding(s, 'search_miss', e.toolName, [search, e], { related: results, detail: 'validation_error' }));
      break;
    }
  }
  return out;
}

/** A tool that failed and was never called successfully again in the session. */
export function abandonment(s: Session): Finding[] {
  const calls = s.events.filter(isCall);
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (let i = calls.length - 1; i >= 0; i--) {
    const e = calls[i]!;
    if (seen.has(e.toolName)) continue;
    seen.add(e.toolName);
    if (e.decision === 'error') out.push(finding(s, 'abandoned', e.toolName, [e], { detail: e.errorCode ?? undefined }));
  }
  return out;
}

export interface SequenceSupport {
  /** Tools in call order. */
  sequence: string[];
  hash: string;
  sessions: number;
  subjects: number;
  /** Share of the analyzed sessions that contain the sequence. */
  share: number;
}

/** Successful tool calls of a session, consecutive duplicates collapsed. */
function successPath(s: Session): string[] {
  const path: string[] = [];
  for (const e of s.events) {
    if (!isCall(e) || !ok(e)) continue;
    if (path[path.length - 1] !== e.toolName) path.push(e.toolName);
  }
  return path;
}

export const sequenceHash = (sequence: string[]) => shortHash(sequence.join('>'));

/**
 * Frequent sequences ("80% of the sessions call A → B → C"): contiguous n-grams of successful
 * calls with minimum support in sessions and in distinct subjects. A sequence contained in a
 * longer one with the same support is dropped.
 */
export function mineSequences(sessions: Session[], opts: { minLength?: number; maxLength?: number; minSessions?: number; minSubjects?: number } = {}): SequenceSupport[] {
  const minLength = opts.minLength ?? 2;
  const maxLength = opts.maxLength ?? 4;
  const minSessions = opts.minSessions ?? 3;
  const minSubjects = opts.minSubjects ?? 2;
  const support = new Map<string, { sequence: string[]; sessions: Set<string>; subjects: Set<string> }>();
  for (const s of sessions) {
    const path = successPath(s);
    for (let n = minLength; n <= maxLength; n++) {
      for (let i = 0; i + n <= path.length; i++) {
        const seq = path.slice(i, i + n);
        if (new Set(seq).size !== seq.length) continue;
        const key = seq.join('>');
        const entry = support.get(key) ?? { sequence: seq, sessions: new Set(), subjects: new Set() };
        entry.sessions.add(s.id);
        entry.subjects.add(s.subject);
        support.set(key, entry);
      }
    }
  }
  const frequent = [...support.values()].filter((e) => e.sessions.size >= minSessions && e.subjects.size >= minSubjects);
  const contains = (long: string[], short: string[]) => long.join('>').includes(short.join('>'));
  return frequent
    .filter((e) => !frequent.some((o) => o.sequence.length > e.sequence.length && o.sessions.size === e.sessions.size && contains(o.sequence, e.sequence)))
    .map((e) => ({
      sequence: e.sequence,
      hash: sequenceHash(e.sequence),
      sessions: e.sessions.size,
      subjects: e.subjects.size,
      share: sessions.length ? Math.round((e.sessions.size / sessions.length) * 1000) / 1000 : 0,
    }))
    .sort((a, b) => b.sessions - a.sessions || b.sequence.length - a.sequence.length);
}

export interface Transition {
  from: string;
  to: string;
  count: number;
}

/** Co-usage: how often one successful tool call follows another in a session. */
export function transitions(sessions: Session[]): Transition[] {
  const counts = new Map<string, Transition>();
  for (const s of sessions) {
    const path = successPath(s);
    for (let i = 1; i < path.length; i++) {
      const key = `${path[i - 1]}>${path[i]}`;
      const t = counts.get(key) ?? { from: path[i - 1]!, to: path[i]!, count: 0 };
      t.count++;
      counts.set(key, t);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

/** Every detector over every session. */
export function analyzeSessions(sessions: Session[]): Finding[] {
  return sessions.flatMap((s) => [...detectLoops(s), ...detectThrash(s), ...searchMisses(s), ...abandonment(s)]);
}
