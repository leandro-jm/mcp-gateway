/**
 * Aggregates a run (ADR-027) and cross-checks it with the gateway's own analytics.
 *
 *   pnpm --filter @mcp-gateway/bench report [--run <id>]   # default: the latest run
 *
 * Output: results/<id>/summary.json and summary.md (pt-BR, the tables of the article). The gateway
 * side comes from the raw call events of the run (`/admin/v1/calls`), filtered by `clientInfo`.
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminClient } from '../src/admin';
import { summarize, type CellSummary, type Rate } from '../src/aggregate';
import { optional, out, required } from '../src/env';
import { readJson, readJsonl, RESULTS_DIR, writeJson } from '../src/files';
import { SCENARIOS } from '../src/mcp';
import { quantile } from '../src/stats';
import type { RunRecord, ScenarioId } from '../src/types';

const argv = process.argv.slice(2);
const i = argv.indexOf('--run');
const runId = i >= 0 ? argv[i + 1]! : readdirSync(RESULTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().at(-1);
if (!runId) throw new Error('no run in results/');
const dir = join(RESULTS_DIR, runId);
const meta = readJson<Record<string, unknown>>(join(dir, 'meta.json'));
const records = readJsonl<RunRecord>(join(dir, 'runs.jsonl'));
if (!records.length) throw new Error(`run ${runId} has no records`);

const cells = summarize(records);
// the headline comparison: the small model through the gateway vs the larger one with every tool, same tasks
const sonnetTasks = new Set(records.filter((r) => r.model.includes('sonnet')).map((r) => r.taskId));
const paired = sonnetTasks.size ? summarize(records, sonnetTasks) : [];

// gateway side: the raw call events of this run (`/admin/v1/calls`), by `clientInfo` = bench-<scenario> / runId.
// Raw events instead of `/analytics/query`: no rollup lag, and the run id tells this run apart from others.
interface CallEvent {
  kind: string;
  agentVersion: string | null;
  decision: string;
  latencyMs: number | null;
  overheadMs: number | null;
}
interface KindStats {
  n: number;
  errors: number;
  latencyP50: number;
  latencyP95: number;
  overheadP50: number;
  overheadP95: number;
}
const starts = records.map((r) => Date.parse(r.startedAt));
const range = { from: new Date(Math.min(...starts) - 60_000).toISOString(), to: new Date(Math.max(...records.map((r, k) => starts.at(k)! + r.durationMs)) + 60_000).toISOString() };
const gateway: Record<string, Record<string, KindStats>> = {};
const adminToken = optional('BENCH_ADMIN_TOKEN');
if (adminToken) {
  const admin = adminClient(required('BENCH_GATEWAY_URL'), adminToken, required('BENCH_TENANT'));
  for (const scenario of new Set(records.map((r) => r.scenario))) {
    const agent = `bench-${scenario}`;
    const events: CallEvent[] = [];
    try {
      for (let cursor: string | null | undefined; ; ) {
        const q = new URLSearchParams({ agent, from: range.from, to: range.to, limit: '200', ...(cursor ? { cursor } : {}) });
        const page = await admin.get<{ items: CallEvent[]; nextCursor?: string | null }>(`/calls?${q}`);
        events.push(...page.items.filter((e) => e.agentVersion === runId));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
    } catch (err) {
      out(`gateway events for ${agent} unavailable: ${(err as Error).message}`);
      continue;
    }
    const byKind: Record<string, KindStats> = {};
    for (const kind of new Set(events.map((e) => e.kind))) {
      const ev = events.filter((e) => e.kind === kind);
      const lat = ev.map((e) => e.latencyMs ?? 0);
      const ovh = ev.map((e) => e.overheadMs ?? 0);
      byKind[kind] = { n: ev.length, errors: ev.filter((e) => e.decision !== 'allow').length, latencyP50: quantile(lat, 0.5), latencyP95: quantile(lat, 0.95), overheadP50: quantile(ovh, 0.5), overheadP95: quantile(ovh, 0.95) };
    }
    gateway[scenario] = byKind;
  }
}

writeJson(join(dir, 'summary.json'), { runId, meta, range, cells, paired, gateway });

// ---------------------------------------------------------------- markdown (pt-BR)
const num = (v: number, digits: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (r: Rate) => (r.n ? `${num(r.p * 100, 0)}% (${num(r.low * 100, 0)}–${num(r.high * 100, 0)})` : '—');
const usd = (v: number, digits = 4) => `US$ ${num(v, digits)}`;
const int = (v: number | null) => (v === null ? '—' : num(Math.round(v), 0));
const sec = (ms: number) => `${num(ms / 1000, 1)} s`;
const label = (s: ScenarioId) => `${s}. ${SCENARIOS[s].label}`;
const table = (head: string[], rows: string[][]) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const models = [...new Set(cells.map((c) => c.model))];
const spent = records.reduce((s, r) => s + r.costUsd, 0);

const md: string[] = [
  `# Benchmark de agentes: ${String(meta.catalogSize)} tools (${runId})`,
  '',
  `Gateway ${String(meta.gateway)}, tenant ${String(meta.tenant)}, source ${String(meta.source)}. ${records.length} execuções, ${usd(spent, 2)} gastos na Anthropic.`,
  'Taxas com intervalo de confiança de 95% (Wilson) entre parênteses. Custo "sem cache" = os mesmos tokens com o cache desligado.',
  '',
];
for (const m of models) {
  const mc = cells.filter((c) => c.model === m);
  md.push(`## ${m}`, '');
  md.push(
    table(
      ['Cenário', 'Execuções', 'Sucesso', '1ª chamada certa', 'Tools no contexto', 'Tokens de definição', 'Tokens de entrada/tarefa', 'Turnos', 'Latência p50 / p95', 'Custo/tarefa', 'Sem cache', '1.000 tarefas'],
      mc.map((c) => [
        label(c.scenario),
        String(c.runs),
        pct(c.success),
        pct(c.firstCallCorrect),
        int(c.toolCount),
        int(c.definitionTokens),
        int(c.promptTokensPerRun),
        num(c.turnsPerRun, 1),
        `${sec(c.latencyP50Ms)} / ${sec(c.latencyP95Ms)}`,
        usd(c.costPerRun),
        usd(c.costUncachedPerRun),
        usd(c.costPerRun * 1000, 2),
      ]),
    ),
    '',
    '**Sucesso por grupo de tarefa**',
    '',
    table(
      ['Cenário', 'Uma tool', 'Várias etapas', 'Ambígua', 'Sem tool'],
      mc.map((c) => [label(c.scenario), ...(['single', 'multi', 'ambiguous', 'none'] as const).map((g) => (c.byGroup[g] ? pct(c.byGroup[g]) : '—'))]),
    ),
    '',
    '**Erros (contagem)**',
    '',
    table(
      ['Cenário', 'Tool inventada', 'Argumento inválido', 'Outro erro de tool', 'Limite de turnos', 'Recusa', 'Erro', 'Chamadas extras/tarefa'],
      mc.map((c) => [label(c.scenario), ...[c.errors.hallucinated, c.errors.validation, c.errors.otherTool, c.errors.maxTurns, c.errors.refusal, c.errors.error].map(String), num(c.errors.extraCallsPerRun, 2)]),
    ),
    '',
    '**Onde vai o tempo (média por tarefa)**',
    '',
    table(
      ['Cenário', 'Modelo', 'Tools (gateway + API)'],
      mc.map((c) => [label(c.scenario), sec(c.modelMsPerRun), sec(c.toolMsPerRun)]),
    ),
    '',
  );
}
if (paired.length) {
  md.push(`## Mesmas ${sonnetTasks.size} tarefas, todos os modelos`, '');
  md.push(
    table(
      ['Modelo', 'Cenário', 'Execuções', 'Sucesso', 'Custo/tarefa', '1.000 tarefas'],
      paired.map((c: CellSummary) => [c.model, label(c.scenario), String(c.runs), pct(c.success), usd(c.costPerRun), usd(c.costPerRun * 1000, 2)]),
    ),
    '',
  );
}
if (Object.keys(gateway).length) {
  const kindLabel: Record<string, string> = { tool: 'chamada de tool', meta: 'meta-tool (busca, schema)', list: 'tools/list', outcome: 'report_outcome', artifact: 'artefato' };
  const ms = (v: number) => `${num(v, 1)} ms`;
  md.push('## Visão do gateway (eventos de `/admin/v1/calls` desta rodada)', '');
  md.push(
    'Latência = tempo total da requisição no gateway, upstream incluído; overhead = só o processamento do gateway. No cenário C, a latência das meta-tools inclui o rerank. No D, o evento do `tools/list` começa depois do shortlist, então a decisão do roteador não entra nessa latência.',
    '',
  );
  md.push(
    table(
      ['Cenário', 'Tipo', 'Eventos', 'Erros', 'Latência p50 / p95', 'Overhead p50 / p95'],
      Object.entries(gateway)
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([s, kinds]) =>
          Object.entries(kinds).map(([k, v]) => [label(s as ScenarioId), kindLabel[k] ?? k, int(v.n), int(v.errors), `${ms(v.latencyP50)} / ${ms(v.latencyP95)}`, `${ms(v.overheadP50)} / ${ms(v.overheadP95)}`]),
        ),
    ),
    '',
  );
}
writeFileSync(join(dir, 'summary.md'), md.join('\n'));
out(`report: ${join(dir, 'summary.md')}`);
