import type { Locale } from './locale';

type DateInput = string | number | Date;

const DATE_TIME: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};

/** Short date and time (`10/03/26, 14:05:09` in en; `03/10/26, 14:05:09` in pt-BR/es). */
export function formatDateTime(locale: Locale, value: DateInput, options: Intl.DateTimeFormatOptions = DATE_TIME): string {
  return new Date(value).toLocaleString(locale, options);
}

export function formatNumber(locale: Locale, value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatPercent(locale: Locale, ratio: number): string {
  return formatNumber(locale, ratio, { style: 'percent', maximumFractionDigits: 0 });
}

/** Bytes in B/KB/MB/GB (base 1024) with one decimal and the locale's decimal separator. */
export function formatBytes(locale: Locale, bytes: number): string {
  if (bytes < 1024) return `${formatNumber(locale, bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${formatNumber(locale, value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${units[unit]}`;
}
