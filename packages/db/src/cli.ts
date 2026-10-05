import { generatePassword, hashPassword } from '@mcp-gateway/core';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrateDown, migrateUp } from './migrate';
import { AuthQueries } from './repositories/auth';
import * as schema from './schema';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const [cmd = 'up', arg] = process.argv.slice(2);
const pool = new pg.Pool({ connectionString: url });
try {
  if (cmd === 'up') {
    const ran = await migrateUp(pool);
    console.warn(ran.length ? `applied: ${ran.join(', ')}` : 'nothing to apply');
  } else if (cmd === 'down') {
    const steps = arg === 'all' ? Infinity : Number(arg ?? 1);
    const reverted = await migrateDown(pool, steps);
    console.warn(reverted.length ? `reverted: ${reverted.join(', ')}` : 'nothing to revert');
  } else if (cmd === 'create-admin') {
    // Bootstrap (ADR-011): creates a platform admin and prints the generated password.
    if (!arg) throw new Error('usage: create-admin <username>');
    const password = generatePassword();
    await new AuthQueries(drizzle(pool, { schema })).createUser(null, {
      username: arg,
      displayName: arg,
      roles: ['gateway-admin'],
      passwordHash: await hashPassword(password),
    });
    console.warn(`platform admin ${arg} created. password: ${password}`);
  } else {
    console.error(`unknown command: ${cmd} (use up | down [n|all] | create-admin <username>)`);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
