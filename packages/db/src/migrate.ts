import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/** In the Docker image (bundle), migrations live in `MIGRATIONS_DIR`. */
export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../migrations', import.meta.url));

interface Migration {
  name: string;
  up: string;
  down: string;
}

async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  return Promise.all(
    files.map(async (f) => {
      const up = await readFile(`${dir}/${f}`, 'utf8');
      let down: string;
      try {
        down = await readFile(`${dir}/down/${f}`, 'utf8');
      } catch {
        throw new Error(`migration ${f} has no matching down file in migrations/down/`);
      }
      return { name: f.replace(/\.sql$/, ''), up: clean(up), down: clean(down) };
    }),
  );
}

const clean = (sql: string) => sql.replaceAll('--> statement-breakpoint', '');

async function ensureTable(client: pg.PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
}

async function applied(client: pg.PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
  return rows.map((r) => r.name);
}

/** Uses an advisory lock to avoid concurrent migrations (several replicas starting together). */
async function withLock<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await ensureTable(client);
    return await fn(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
}

export async function migrateUp(pool: pg.Pool, dir?: string): Promise<string[]> {
  const migrations = await loadMigrations(dir);
  return withLock(pool, async (client) => {
    const done = new Set(await applied(client));
    const ran: string[] = [];
    for (const m of migrations) {
      if (done.has(m.name)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.up);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [m.name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.name} failed: ${(err as Error).message}`, { cause: err });
      }
      ran.push(m.name);
    }
    return ran;
  });
}

/** Reverts the last `steps` migrations (`Infinity` reverts all of them). */
export async function migrateDown(pool: pg.Pool, steps = 1, dir?: string): Promise<string[]> {
  const migrations = new Map((await loadMigrations(dir)).map((m) => [m.name, m]));
  return withLock(pool, async (client) => {
    const done = (await applied(client)).reverse();
    const reverted: string[] = [];
    for (const name of done.slice(0, steps)) {
      const m = migrations.get(name);
      if (!m) throw new Error(`applied migration ${name} does not exist in the directory`);
      await client.query('BEGIN');
      try {
        await client.query(m.down);
        await client.query('DELETE FROM schema_migrations WHERE name = $1', [name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`failed to revert ${name}: ${(err as Error).message}`, { cause: err });
      }
      reverted.push(name);
    }
    return reverted;
  });
}
