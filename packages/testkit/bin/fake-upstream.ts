import { startFakeUpstream } from '../src/upstream';

const port = Number(process.env.FAKE_UPSTREAM_PORT ?? 4010);
const up = await startFakeUpstream({
  port,
  host: process.env.FAKE_UPSTREAM_HOST ?? '127.0.0.1',
  colaboradores: Number(process.env.FAKE_UPSTREAM_COLABORADORES ?? 50),
});
console.warn(`fake HR upstream at ${up.url} (spec: ${up.url}/openapi.json)`);
