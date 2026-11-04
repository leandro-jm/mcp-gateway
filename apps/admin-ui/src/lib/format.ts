import { formatDateTime, formatNumber } from '@mcp-gateway/i18n';
import { getLocale } from '../i18n';

/** Display formatters for dashboards and chart tooltips, in the active locale. */

export const ms = (v: number | null | undefined) => (v == null ? '—' : `${formatNumber(getLocale(), Math.round(v))} ms`);

export const pct = (v: number | null | undefined) => (v == null ? '—' : formatNumber(getLocale(), v, { style: 'percent', maximumFractionDigits: 1 }));

export const money = (v: number, currency: string) => formatNumber(getLocale(), v, { style: 'currency', currency });

/** 1,284 → 1.3K (axis ticks and tight labels). */
export const compact = (v: number) => formatNumber(getLocale(), v, { notation: 'compact', maximumFractionDigits: 1 });

/** Bucket label: day/month and time. */
export const hourLabel = (iso: string) => formatDateTime(getLocale(), iso, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Time of day with seconds. */
export const timeLabel = (iso: string) => formatDateTime(getLocale(), iso, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
