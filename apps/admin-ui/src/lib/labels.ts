import type { T, UiMessageKey } from '../i18n';

/**
 * Labels for enum values shown to users. The API sends machine values (`enabled`, `allow`…);
 * the UI translates them at render time with `enumLabel(t, TOOL_STATE_LABEL, value)`.
 * Unknown values fall back to the raw value.
 */
export type EnumLabels = Readonly<Record<string, UiMessageKey>>;

export const TOOL_STATE_LABEL: EnumLabels = {
  enabled: 'common.toolStateEnabled',
  disabled: 'common.toolStateDisabled',
  deprecated: 'common.toolStateDeprecated',
  removed: 'common.toolStateRemoved',
};

export const TOOL_KIND_LABEL: EnumLabels = {
  openapi: 'common.toolKindOpenapi',
  manual: 'common.toolKindManual',
  composite: 'common.toolKindComposite',
};

export const EFFECT_LABEL: EnumLabels = {
  allow: 'common.effectAllow',
  deny: 'common.effectDeny',
};

export const DECISION_LABEL: EnumLabels = {
  allow: 'common.decisionAllow',
  deny: 'common.decisionDeny',
  error: 'common.decisionError',
  applied: 'common.decisionApplied',
  rejected: 'common.decisionRejected',
};

export const CRAWL_STATUS_LABEL: EnumLabels = {
  queued: 'common.crawlStatusQueued',
  running: 'common.crawlStatusRunning',
  succeeded: 'common.crawlStatusSucceeded',
  failed: 'common.crawlStatusFailed',
};

export const CRAWL_TRIGGER_LABEL: EnumLabels = {
  manual: 'common.crawlTriggerManual',
  cron: 'common.crawlTriggerCron',
};

export const SOURCE_STATUS_LABEL: EnumLabels = {
  active: 'common.sourceStatusActive',
  paused: 'common.sourceStatusPaused',
  error: 'common.sourceStatusError',
};

export const DRIFT_KIND_LABEL: EnumLabels = {
  added: 'common.driftKindAdded',
  changed: 'common.driftKindChanged',
  removed: 'common.driftKindRemoved',
  breaking: 'common.driftKindBreaking',
};

export const PROJECTION_STATUS_LABEL: EnumLabels = {
  active: 'common.projectionStatusActive',
  suggested: 'common.projectionStatusSuggested',
};

/** Translated label of an enum value, or the raw value when there is no label for it. */
export function enumLabel(t: T, labels: EnumLabels, value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const key = labels[value];
  return key ? t(key) : value;
}
