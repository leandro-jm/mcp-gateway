import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Metrics } from '../src/telemetry/metrics';

const file = fileURLToPath(new URL('../../../docs/observability/prometheus-rules.yml', import.meta.url));

describe('Prometheus rules (F15.10)', () => {
  it('parse and only reference metrics the gateway exports', async () => {
    const doc = parse(readFileSync(file, 'utf8')) as { groups: Array<{ rules: Array<{ expr: string; alert?: string; record?: string }> }> };
    const rules = doc.groups.flatMap((g) => g.rules);
    expect(rules.length).toBeGreaterThan(5);
    const exported = new Set((await new Metrics().registry.getMetricsAsJSON()).map((m) => m.name));
    const recorded = new Set(rules.flatMap((r) => (r.record ? [r.record] : [])));
    for (const r of rules) {
      for (const name of r.expr.match(/\b(?:mcp_|slo:)[a-z_:0-9]+/g) ?? []) {
        if (recorded.has(name)) continue;
        const base = name.replace(/_(bucket|count|sum)$/, '');
        expect(exported.has(base), `${r.alert ?? r.record}: ${name}`).toBe(true);
      }
    }
  });
});
