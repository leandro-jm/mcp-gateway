import { describe, expect, it } from 'vitest';
import { validateQuery } from './query';

const now = new Date('2026-10-04T12:00:00Z');

describe('validateQuery (F15.9)', () => {
  it('normalizes a valid query (defaults and resolved range)', () => {
    const v = validateQuery({ metric: 'calls', groupBy: ['tool'], range: { last: '24h' } }, now);
    expect(v).toEqual({
      ok: true,
      query: { metric: 'calls', groupBy: ['tool'], filters: {}, from: new Date('2026-10-03T12:00:00Z'), to: now, limit: 20, order: 'desc' },
    });
    const f = validateQuery({ metric: 'latency_p95', filters: { tool: 'x', decision: ['allow', 'error'] }, range: { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' } }, now);
    expect(f.ok && f.query.filters).toEqual({ tool: ['x'], decision: ['allow', 'error'] });
  });

  it('rejects unknown metrics, dimensions, filters and fields with localized messages', () => {
    const bad = (q: unknown) => {
      const v = validateQuery(q, now);
      return v.ok ? undefined : v.error.key;
    };
    expect(bad({ metric: 'select 1', range: { last: '1h' } })).toBe('analytics.unknownMetric');
    expect(bad({ metric: 'calls', groupBy: ['subject'], range: { last: '1h' } })).toBe('analytics.unknownDimension');
    expect(bad({ metric: 'calls', groupBy: ['tool', 'client', 'agent'], range: { last: '1h' } })).toBe('analytics.tooManyGroupBy');
    expect(bad({ metric: 'calls', filters: { subject: 'x' }, range: { last: '1h' } })).toBe('analytics.unknownFilter');
    expect(bad({ metric: 'calls', filters: { tool: '' }, range: { last: '1h' } })).toBe('analytics.invalidFilterValue');
    expect(bad({ metric: 'calls', range: { last: '1h' }, sql: 'DROP TABLE x' })).toBe('analytics.invalidQuery');
    expect(bad({ metric: 'calls', range: { last: '2y' } })).toBe('analytics.invalidRange');
    expect(bad({ metric: 'calls', range: { from: '2026-01-01', to: '2026-12-31' } })).toBe('analytics.rangeTooLarge');
    expect(bad({ metric: 'calls', range: { from: '2026-02-01', to: '2026-01-01' } })).toBe('analytics.invalidRange');
    expect(bad({ metric: 'calls', range: { last: '1h' }, limit: 1000 })).toBe('analytics.invalidLimit');
    expect(bad('calls')).toBe('analytics.invalidQuery');
  });

  it('keeps SQL-looking text as a plain filter value (bound later)', () => {
    const v = validateQuery({ metric: 'calls', filters: { tool: "x' OR 1=1 --" }, range: { last: '1h' } }, now);
    expect(v.ok && v.query.filters.tool).toEqual(["x' OR 1=1 --"]);
  });
});
