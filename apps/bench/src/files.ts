import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Task, TaskGroup } from './types';

/** `apps/bench`, whatever the cwd. */
export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RESULTS_DIR = join(APP_DIR, 'results');

/** One snapshot per gateway and tenant, so a local rehearsal never stands in for production. */
export const snapshotFile = (baseUrl: string, tenant: string) => join(RESULTS_DIR, `snapshot-${new URL(baseUrl).host.replace(/[^a-z0-9.-]/gi, '_')}-${tenant}.json`);

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

export function appendJsonl(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(value)}\n`);
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

/** Sets `KEY=value` in `apps/bench/.env` (or `BENCH_ENV_FILE`), creating the line if needed. */
export function setEnvValue(key: string, value: string): void {
  const file = join(APP_DIR, process.env.BENCH_ENV_FILE ?? '.env');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  writeFileSync(file, re.test(text) ? text.replace(re, line) : `${text}${text.endsWith('\n') || !text ? '' : '\n'}${line}\n`);
}

const GROUPS: ReadonlySet<TaskGroup> = new Set(['single', 'multi', 'ambiguous', 'none']);

export function loadTasks(file: string): Task[] {
  const tasks = readJsonl<Task>(file);
  if (!tasks.length) throw new Error(`no tasks in ${file}`);
  const ids = new Set<string>();
  for (const t of tasks) {
    if (!t.id || ids.has(t.id)) throw new Error(`${file}: missing or duplicate task id "${t.id}"`);
    ids.add(t.id);
    if (!GROUPS.has(t.group)) throw new Error(`${file}: task ${t.id} has an invalid group "${t.group}"`);
    if (!t.prompt?.trim()) throw new Error(`${file}: task ${t.id} has no prompt`);
    if (!Array.isArray(t.expected) || (t.group === 'none') !== (t.expected.length === 0)) {
      throw new Error(`${file}: task ${t.id}: \`none\` tasks have no expected calls, the others at least one`);
    }
  }
  return tasks;
}
