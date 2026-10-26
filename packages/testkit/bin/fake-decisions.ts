import { startFakeDecisions } from '../src/fake-decisions';

const port = Number(process.env.FAKE_DECISIONS_PORT ?? 4020);
const server = await startFakeDecisions({ port, host: process.env.FAKE_DECISIONS_HOST ?? '127.0.0.1' });
console.warn(`fake decision provider at ${server.url} (OpenAI Decisions: /decisions, Jev: /systemone)`);
