import { analyzeSessions, mineSequences, sessionize, transitions, type Session } from '@mcp-gateway/call-analytics';
import type { Services } from '../services';

const DAY = 86_400_000;
const LOCK_KEY = 'mcp-gw:agent-analytics:lock';

export interface AgentAnalyticsReport {
  skipped: boolean;
  tenants: number;
  sessions: number;
  findings: number;
  suggestions: number;
}

export interface AgentAnalyticsOptions {
  /** Sessions mined for sequences and co-usage. */
  lookbackDays?: number;
  /** Findings are (re)computed for sessions that ended in this window. */
  findingsWindowMs?: number;
  lockMs?: number;
  /** Only these tenants (on-demand refresh by a tenant admin). */
  tenantIds?: string[];
}

/**
 * Agent analytics job (F15.21): sessionizes the recent call events of each tenant, stores the bad
 * patterns found (loops, thrash, search misses, abandonment), the daily co-usage and frequent
 * sequences as composite suggestions. A Redis lease keeps replicas from running it twice.
 */
export async function runAgentAnalytics(services: Services, now = new Date(), opts: AgentAnalyticsOptions = {}): Promise<AgentAnalyticsReport> {
  const lockMs = opts.lockMs ?? 10 * 60_000;
  const acquired = await services.redis.set(LOCK_KEY, String(now.getTime()), 'PX', lockMs, 'NX');
  const report: AgentAnalyticsReport = { skipped: acquired !== 'OK', tenants: 0, sessions: 0, findings: 0, suggestions: 0 };
  if (report.skipped) return report;
  const repo = services.repos.agentAnalytics;
  const from = new Date(now.getTime() - (opts.lookbackDays ?? 7) * DAY);
  const findingsFrom = new Date(now.getTime() - (opts.findingsWindowMs ?? 2 * 3_600_000));
  try {
    await services.callEvents.flush();
    for (const tenantId of opts.tenantIds ?? (await services.repos.system.tenantIds())) {
      const sessions = sessionize(await repo.trajectoryEvents(tenantId, from, now));
      if (!sessions.length) continue;
      report.tenants++;
      report.sessions += sessions.length;
      report.findings += await repo.upsertFindings(tenantId, analyzeSessions(sessions.filter((s) => s.end >= findingsFrom)));

      const byDay = new Map<string, Session[]>();
      for (const s of sessions) {
        const day = s.start.toISOString().slice(0, 10);
        byDay.set(day, [...(byDay.get(day) ?? []), s]);
      }
      await repo.replaceTransitions(tenantId, new Map([...byDay].map(([day, list]) => [day, transitions(list)])));

      // only sequences of existing, enabled, non-composite tools can become a composite
      const snapshot = await services.registry.get(tenantId);
      const usable = new Set(snapshot.tools.filter((t) => t.state === 'enabled' && t.kind !== 'composite').map((t) => t.name));
      const seqs = mineSequences(sessions).filter((s) => s.sequence.every((name) => usable.has(name)));
      await repo.upsertSuggestions(tenantId, seqs, now);
      report.suggestions += seqs.length;
    }
  } finally {
    await services.redis.del(LOCK_KEY);
  }
  return report;
}
