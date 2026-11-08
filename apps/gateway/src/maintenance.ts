import type { RollupReport } from '@mcp-gateway/db';
import type { Services } from './services';

export interface MaintenanceReport {
  artifacts: number;
  piiTokens: number;
  auditPartitions: string[];
  auditDropped: string[];
  callEventPartitions: string[];
  callEventsDropped: string[];
  rollups: RollupReport;
  subjectRefPartitions: string[];
  subjectRefsDropped: string[];
  debugItems: number;
  searchBackfilled: number;
  /** OAuth (F20.7): expired codes and refresh tokens past the reuse-detection window, and DCR clients unused for 30 days. */
  oauth: { codes: number; refreshTokens: number; dcrClients: number };
}

/** DCR clients unused this long are removed (ADR-030); their refresh tokens expired long before. */
const DCR_CLIENT_IDLE_MS = 30 * 24 * 3_600_000;

/**
 * Maintenance job: expired artifacts (F8.1), expired PII tokens (F5) and
 * audit partitions (creates the next ones and drops those outside retention, F9.1) and
 * call event partitions (daily, F15.5), the analytics rollups (F15.8) and OAuth secrets and idle DCR clients (F20.7).
 */
export async function runMaintenance(services: Services, now = new Date()): Promise<MaintenanceReport> {
  const artifacts = await services.artifacts.cleanup(services.repos.system);
  const piiTokens = await services.repos.system.deleteExpiredPiiTokens(now);
  const auditPartitions = await services.repos.system.ensureAuditPartitions(2);
  const auditDropped = await services.repos.system.dropAuditPartitionsOlderThan(services.config.AUDIT_RETENTION_MONTHS, now);
  const callEventPartitions = await services.repos.system.ensureCallEventPartitions(3);
  const callEventsDropped = await services.repos.system.dropCallEventPartitionsOlderThan(services.config.CALL_EVENTS_RETENTION_DAYS, now);
  const subjectRefPartitions = await services.repos.system.ensureSubjectRefPartitions(2);
  const subjectRefsDropped = await services.repos.system.dropSubjectRefPartitionsOlderThan(services.config.SUBJECT_INDEX_RETENTION_MONTHS, now);
  const debugItems = await services.debug.cleanup(now);
  await services.callEvents.flush();
  const rollups = await services.repos.rollups.rollup(now);
  await services.repos.rollups.prune(services.config.CALL_ROLLUPS_RETENTION_DAYS, now);
  const searchBackfilled = await services.repos.system.backfillSearchText();
  const purged = await services.repos.oauth.purgeExpired(now);
  const dcrClients = await services.repos.oauth.deleteStaleDcrClients(new Date(now.getTime() - DCR_CLIENT_IDLE_MS));
  return {
    artifacts,
    piiTokens,
    auditPartitions,
    auditDropped,
    callEventPartitions,
    callEventsDropped,
    rollups,
    subjectRefPartitions,
    subjectRefsDropped,
    debugItems,
    searchBackfilled,
    oauth: { ...purged, dcrClients },
  };
}
