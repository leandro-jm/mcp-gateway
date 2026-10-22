import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Deterministic decision-model server for tests and local demos (ADR-025). Speaks the OpenAI
 * Decisions (`POST /v1/decisions`) and TypeSafe Jev (`POST /v1/systemone`) wire formats:
 * - choice: options ranked by word overlap with the `<data>` blocks of the input; `none` when nothing overlaps;
 * - predicate `risky`: by the tool effect in the input (destructive 0.6, writes 0.2, read-only 0.05);
 * - predicate `off_intent`: 0.7 when the task and the tool share no word, else 0.1;
 * - any other predicate: 0.5.
 */
export interface FakeDecisionsOptions {
  port?: number;
  host?: string;
  /** Bearer the server accepts (default: any). */
  apiKey?: string;
}

export interface FakeDecisionsServer {
  url: string;
  app: FastifyInstance;
  /** Every request body received, in order. */
  requests: Array<{ path: string; body: unknown }>;
  /** Next responses use this HTTP status (e.g. 500, 429) until reset to undefined. */
  failWith: number | undefined;
  /** Delay before answering, in ms (timeout tests). */
  delayMs: number;
  close(): Promise<void>;
}

type Question = { name: string; type: string; instructions?: string; choices?: Array<{ value: string; description: string }> };

const words = (text: string) =>
  new Set(
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3)
      .map((w) => w.slice(0, 5)),
  );

const dataBlocks = (input: string) => {
  const blocks: Record<string, string> = {};
  for (const m of input.matchAll(/<data name="([^"]+)">([\s\S]*?)<\/data>/g)) blocks[m[1]!] = m[2]!;
  return blocks;
};

const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((w) => b.has(w)).length;

export function fakeAnswer(input: string, q: Question): Record<string, unknown> {
  const blocks = dataBlocks(input);
  if (q.type === 'choice') {
    const query = words(Object.values(blocks).join(' '));
    const scored = (q.choices ?? []).filter((c) => c.value !== 'none').map((c) => ({ value: c.value, score: overlap(query, words(c.description)) ** 2 }));
    const total = scored.reduce((n, s) => n + s.score, 0);
    if (!total) return { choice: 'none', probabilities: { none: 0.9 }, confidence: 0.9 };
    const probabilities = Object.fromEntries(scored.map((s) => [s.value, Number((s.score / total).toFixed(4))]));
    const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
    return { choice: best.value, probabilities: { ...probabilities, none: 0 }, confidence: probabilities[best.value] };
  }
  if (q.type === 'score') return { score: 0, probabilities: {}, confidence: 0.5 };
  if (q.name === 'risky') {
    const tool = blocks.tool ?? '';
    return { probability: tool.includes('[effect: destructive]') ? 0.6 : tool.includes('[effect: writes data]') ? 0.2 : 0.05 };
  }
  if (q.name === 'off_intent') return { probability: overlap(words(blocks.task ?? ''), words(blocks.tool ?? '')) ? 0.1 : 0.7 };
  return { probability: 0.5 };
}

export async function startFakeDecisions(opts: FakeDecisionsOptions = {}): Promise<FakeDecisionsServer> {
  const app = Fastify({ logger: false });
  const state: FakeDecisionsServer = {
    url: '',
    app,
    requests: [],
    failWith: undefined,
    delayMs: 0,
    close: () => app.close(),
  };

  const guard = async (path: string, auth: string | undefined, body: unknown): Promise<number | undefined> => {
    state.requests.push({ path, body });
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (opts.apiKey && auth !== `Bearer ${opts.apiKey}`) return 401;
    return state.failWith;
  };

  app.post('/v1/decisions', async (req, reply) => {
    const body = req.body as { input: string; questions: Question[] };
    const status = await guard('/v1/decisions', req.headers.authorization, body);
    if (status) return reply.code(status).send({ error: { message: 'fake failure' } });
    const answers = body.questions.map((q) => ({ name: q.name, ...fakeAnswer(body.input, q) }));
    return { answers, usage: { input_tokens: Math.ceil(JSON.stringify(body).length / 4) } };
  });

  app.post('/v1/systemone', async (req, reply) => {
    const body = req.body as { state: string; questions: Record<string, { type: string; instructions?: string; criteria?: Record<string, string> }> };
    const status = await guard('/v1/systemone', req.headers.authorization, body);
    if (status) return reply.code(status).send({ error: 'fake failure' });
    const answers: Record<string, unknown> = {};
    for (const [name, q] of Object.entries(body.questions)) {
      const type = q.type === 'noul' ? 'predicate' : q.type;
      const choices = q.type === 'choice' ? Object.entries(q.criteria ?? {}).map(([value, description]) => ({ value, description })) : undefined;
      answers[name] = fakeAnswer(body.state, { name, type, ...(choices ? { choices } : {}) });
    }
    return { answers };
  });

  const address = await app.listen({ port: opts.port ?? 0, host: opts.host ?? '127.0.0.1' });
  state.url = `${address}/v1`;
  return state;
}
