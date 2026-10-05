import { createDb } from './client';
import { seedDev } from './seed';

// Fixed passwords (admin/admin…) and a published agent token: development only.
if (process.env.NODE_ENV === 'production') {
  console.error('the dev seed cannot run with NODE_ENV=production; use `pnpm db:create-admin <username>`');
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const handle = createDb(url);
try {
  const r = await seedDev(handle.db, { upstreamUrl: process.env.DEV_UPSTREAM_URL });
  console.warn(`seed ok: tenant=${r.tenantId} source=${r.sourceId}`);
  console.warn('users: admin/admin (platform), owner/owner, owner-pt/owner-pt, owner-es/owner-es, agente/agente');
  console.warn(`agent-dev token: ${r.agentToken}`);
} finally {
  await handle.close();
}
