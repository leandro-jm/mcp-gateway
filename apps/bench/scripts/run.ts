/**
 * Runs the benchmark (ADR-027): every task × repetition × model through scenarios A and B with the
 * router off (phase 1), then C and D with it on (phase 2). Sequential, resumable, with hard spend caps.
 *
 *   pnpm --filter @mcp-gateway/bench bench --pilot                       # first 5 tasks, 1 repetition
 *   pnpm --filter @mcp-gateway/bench bench --run <id> --limit claude-sonnet-5-5:20
 *   pnpm --filter @mcp-gateway/bench bench --fake-model --tasks tasks/dev.jsonl   # no model calls
 *
 * Options: --run <id> (resume; default: new id) · --tasks <file> (default tasks/tasks.jsonl) ·
 * --reps model:n,... (default haiku 3, others 1) · --limit model:n,... (default sonnet 20) ·
 * --scenarios A,B,C,D · --max-turns 12.
 * Caps: BENCH_MAX_USD (total, default 10) and BENCH_MODEL_MAX_USD (model:usd,...). Before each run the
 * mean cost of that model × scenario so far is checked against what is left; phase 1 only gets its
 * share (measured on the pilot), so phase 2 always has budget.
 */
import Anthropic from '@anthropic-ai/sdk';
import { join } from 'node:path';
import { adminClient, findSource, type ToolDto } from '../src/admin';
import { runAgent, toApiTools } from '../src/agent';
import { pricesFor, runCost, type PriceTable } from '../src/cost';
import { modelCaps, numberEnv, optional, out, required } from '../src/env';
import { APP_DIR, appendJsonl, loadTasks, readJson, readJsonl, RESULTS_DIR, writeJson } from '../src/files';
import { callMcpTool, connectScenario, listAllTools, SCENARIOS, type Scenario } from '../src/mcp';
import { anthropicModel, fakeModel, type AgentModel } from '../src/model';
import { putRouterSettings, routerView, setRouter } from '../src/router';
import { scoreRun } from '../src/score';
import { mean } from '../src/stats';
import type { RunRecord, ScenarioId, Task } from '../src/types';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const perModel = (spec: string | undefined) =>
  Object.fromEntries((spec ?? '').split(',').filter(Boolean).map((p) => [p.split(':')[0]!, Number(p.split(':')[1])])) as Record<string, number>;

const fake = flag('fake-model');
const pilot = flag('pilot');
const runId = arg('run') ?? new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const tasksFile = join(APP_DIR, arg('tasks') ?? 'tasks/tasks.jsonl');
const maxTurns = Number(arg('max-turns') ?? 12);
const scenarioIds = (arg('scenarios') ?? 'A,B,C,D').split(',') as ScenarioId[];
const models = fake ? ['fake'] : (optional('BENCH_MODELS') ?? 'claude-haiku-5-5,claude-sonnet-5-5').split(',').map((m) => m.trim());
const reps = { 'claude-haiku-5-5': 3, ...perModel(arg('reps')) } as Record<string, number>;
const limits = { 'claude-sonnet-5-5': 20, ...perModel(arg('limit')) } as Record<string, number>;
const totalCap = numberEnv('BENCH_MAX_USD', 10);
const caps = { 'claude-haiku-5-5': 4, 'claude-sonnet-5-5': 6, ...modelCaps('BENCH_MODEL_MAX_USD') } as Record<string, number>;

const baseUrl = required('BENCH_GATEWAY_URL');
const agentToken = required('BENCH_AGENT_TOKEN');
const admin = adminClient(baseUrl, required('BENCH_ADMIN_TOKEN'), required('BENCH_TENANT'));
const tasks = loadTasks(tasksFile);
const prices = readJson<{ models: PriceTable }>(join(APP_DIR, 'prices.json')).models;
const anthropic = fake ? null : new Anthropic({ maxRetries: 4 });
const realModels = new Map(anthropic ? models.map((m) => [m, anthropicModel(anthropic, m)]) : []);

const source = await findSource(admin, required('BENCH_SOURCE_NAME'));
const catalog = new Set((await admin.listAll<ToolDto>(`/tools?sourceId=${source.id}&state=enabled`)).map((t) => t.name));
const unknown = [...new Set(tasks.flatMap((t) => t.expected.flatMap((e) => [e.tool, ...(e.alt ?? []).map((a) => a.tool)])))].filter((n) => !catalog.has(n));
if (unknown.length) throw new Error(`answer key names tools that are not enabled in the source: ${unknown.join(', ')}`);
const runsFile = join(RESULTS_DIR, runId, 'runs.jsonl');
const records = readJsonl<RunRecord>(runsFile);
const done = new Set(records.map((r) => r.key));
writeJson(join(RESULTS_DIR, runId, 'meta.json'), {
  runId,
  gateway: new URL(baseUrl).host,
  tenant: admin.tenant,
  source: source.name,
  catalogSize: catalog.size,
  tasksFile: arg('tasks') ?? 'tasks/tasks.jsonl',
  models,
  reps,
  limits,
  caps: { total: totalCap, ...caps },
  updatedAt: new Date().toISOString(),
});

const tasksFor = (model: string) => (pilot ? tasks.slice(0, 5) : tasks.slice(0, limits[model] ?? tasks.length));
const repsFor = (model: string) => (pilot ? 1 : (reps[model] ?? 1));

// ---------------------------------------------------------------- budget
const spent = (pred: (r: RunRecord) => boolean) => records.filter(pred).reduce((s, r) => s + r.costUsd, 0);
const meanCost = (model: string, scenario: ScenarioId) => mean(records.filter((r) => r.model === model && r.scenario === scenario).map((r) => r.costUsd));
/** Phase 1's share of a model's cap: its planned cost over the total, from the costs measured so far. */
function phaseCap(model: string, phase: 1 | 2): number {
  const cap = caps[model] ?? totalCap;
  if (phase === 2) return cap - spent((r) => r.model === model && r.phase === 1);
  const cost = (p: 1 | 2) => scenarioIds.filter((s) => SCENARIOS[s].phase === p).reduce((sum, s) => sum + meanCost(model, s), 0);
  const [c1, c2] = [cost(1), cost(2)];
  return c1 > 0 && c2 > 0 ? (cap * c1) / (c1 + c2) : cap / 2;
}
const capped = new Set<string>();
function withinBudget(model: AgentModel, scenario: Scenario): boolean {
  if (!model.billed) return true;
  const next = meanCost(model.id, scenario.id);
  const ok =
    spent(() => true) + next <= totalCap &&
    spent((r) => r.model === model.id) + next <= (caps[model.id] ?? totalCap) &&
    spent((r) => r.model === model.id && r.phase === scenario.phase) + next <= phaseCap(model.id, scenario.phase);
  if (!ok && !capped.has(`${model.id}|${scenario.phase}`)) {
    capped.add(`${model.id}|${scenario.phase}`);
    out(`budget: ${model.id} reached its cap for phase ${scenario.phase}; skipping its remaining runs there`);
  }
  return ok;
}

// ---------------------------------------------------------------- one run
const defTokens = new Map<string, number>();
async function execRun(modelId: string, scenario: Scenario, task: Task, rep: number): Promise<RunRecord | null> {
  const key = `${modelId}|${scenario.id}|${task.id}|${rep}`;
  if (done.has(key)) return null;
  const model = fake ? fakeModel(task, scenario.omni) : realModels.get(modelId)!;
  if (!withinBudget(model, scenario)) return null;
  const startedAt = new Date();
  const t0 = performance.now();
  const client = await connectScenario(baseUrl, agentToken, scenario, task, runId);
  let record: RunRecord;
  try {
    const mcpTools = await listAllTools(client);
    const tools = toApiTools(mcpTools);
    const sig = `${modelId}|${mcpTools.map((t) => t.name).join(',')}`;
    if (!defTokens.has(sig)) defTokens.set(sig, await model.definitionTokens(tools));
    const result = await runAgent({ model, mcp: client, tools, instructions: client.getInstructions(), prompt: task.prompt, maxTurns });
    const cost = model.billed ? runCost(result.turns.map((t) => t.usage), pricesFor(prices, modelId)) : { cached: 0, uncached: 0 };
    record = {
      key,
      runId,
      phase: scenario.phase,
      scenario: scenario.id,
      model: modelId,
      taskId: task.id,
      group: task.group,
      rep,
      pilot,
      startedAt: startedAt.toISOString(),
      durationMs: performance.now() - t0,
      toolCount: mcpTools.length,
      definitionTokens: defTokens.get(sig) ?? null,
      turns: result.turns,
      outcome: result.outcome,
      ...(result.error ? { error: result.error } : {}),
      costUsd: cost.cached,
      costUncachedUsd: cost.uncached,
      score: scoreRun(task, result.turns.flatMap((t) => t.calls), catalog, result.outcome),
    };
  } finally {
    await client.close();
  }
  appendJsonl(runsFile, record);
  records.push(record);
  done.add(key);
  const s = record.score;
  out(
    `${scenario.id} ${modelId.padEnd(17)} ${task.id.padEnd(6)} r${rep} ${s.success ? 'ok  ' : 'FAIL'} ${record.outcome.padEnd(9)} ` +
      `${String(record.turns.length).padStart(2)} turns ${(record.durationMs / 1000).toFixed(1).padStart(5)}s ` +
      `$${record.costUsd.toFixed(4)} | spent $${spent(() => true).toFixed(2)}`,
  );
  return record;
}

// ---------------------------------------------------------------- phases
let stop = false;
process.on('SIGINT', () => {
  out('\nstopping after the current run (Ctrl+C again to abort)');
  if (stop) process.exit(130);
  stop = true;
});

async function phase(p: 1 | 2): Promise<void> {
  const scenarios = scenarioIds.map((id) => SCENARIOS[id]).filter((s) => s.phase === p);
  if (!scenarios.length) return;
  const maxTasks = Math.max(...models.map((m) => tasksFor(m).length));
  const maxReps = Math.max(...models.map(repsFor));
  for (let ti = 0; ti < maxTasks && !stop; ti++) {
    for (let rep = 1; rep <= maxReps && !stop; rep++) {
      for (const m of models) {
        const task = tasksFor(m).at(ti);
        if (!task || rep > repsFor(m)) continue;
        for (const s of scenarios) {
          if (stop) break;
          // a failed connection is not recorded: a later `--run <id>` retries it
          await execRun(m, s, task, rep).catch((err: Error) => out(`${s.id} ${m} ${task.id} r${rep} not recorded: ${err.message}`));
        }
      }
    }
  }
}

/** First requests after a router toggle rebuild the registry snapshot: done here, outside the measurement. */
async function warmUp(): Promise<void> {
  const task = tasks[0]!;
  for (const s of [SCENARIOS.C, SCENARIOS.D]) {
    const c = await connectScenario(baseUrl, agentToken, s, task, `${runId}-warmup`);
    try {
      await listAllTools(c);
      if (s.omni) await callMcpTool(c, 'search_tools', { query: task.prompt });
    } finally {
      await c.close();
    }
  }
}

const view = await routerView(admin);
const needsRouter = scenarioIds.some((id) => SCENARIOS[id].phase === 2);
if (needsRouter && !(view.platformEnabled && view.provider.configured)) {
  throw new Error('scenarios C and D need TOOL_ROUTER_ENABLED=true on the gateway and a decision provider (run env:setup with JEV_API_KEY); or pass --scenarios A,B');
}
out(`run ${runId}: ${tasks.length} tasks in ${tasksFile}, models ${models.join(', ')}${pilot ? ', PILOT' : ''}; ${records.length} runs already recorded`);
try {
  if (view.settings.enabled) await setRouter(admin, false);
  await phase(1);
  if (needsRouter && !stop) {
    await setRouter(admin, true);
    await warmUp();
    await phase(2);
  }
} finally {
  await putRouterSettings(admin, view.settings);
  out('router: settings restored to their state before the run');
}

// ---------------------------------------------------------------- summary
out(`\nspent $${spent(() => true).toFixed(2)} of $${totalCap} (${records.length} runs)`);
for (const m of models) {
  for (const id of scenarioIds) {
    const rs = records.filter((r) => r.model === m && r.scenario === id);
    if (!rs.length) continue;
    out(`  ${m} ${id}: ${rs.filter((r) => r.score.success).length}/${rs.length} ok, mean $${mean(rs.map((r) => r.costUsd)).toFixed(4)}/run`);
  }
}
if (pilot && !fake) {
  out('\nprojection for the full run:');
  for (const m of models) {
    const perTask = scenarioIds.reduce((s, id) => s + meanCost(m, id), 0);
    const full = Math.min(tasks.length, limits[m] ?? tasks.length) * (reps[m] ?? 1);
    const cap = caps[m] ?? totalCap;
    out(`  ${m}: $${perTask.toFixed(4)} per task (4 scenarios) → ${full} task-runs ≈ $${(perTask * full).toFixed(2)} (cap $${cap}); fits ${Math.floor((0.9 * cap) / Math.max(perTask, 1e-9))} task-runs`);
  }
  out(`\ncontinue with: pnpm --filter @mcp-gateway/bench bench --run ${runId} [--limit claude-sonnet-5-5:N]`);
}
