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
}

/**
 * Maintenance job: expired artifacts (F8.1), expired PII tokens (F5) and
 * audit partitions (creates the next ones and drops those outside retention, F9.1) and
 * call event partitions (daily, F15.5) and the analytics rollups (F15.8).
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
  return { artifacts, piiTokens, auditPartitions, auditDropped, callEventPartitions, callEventsDropped, rollups, subjectRefPartitions, subjectRefsDropped, debugItems, searchBackfilled };
}
