import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  ESCALAS,
  generateColaboradores,
  generateMarcacoes,
  type Colaborador,
  type Marcacao,
} from './fake-data';
import { rhOpenApiSpec } from './openapi-rh';
import { rhPostmanCollection } from './postman-rh';

export const FAKE_CREDENTIALS = {
  clientId: 'gateway-client',
  clientSecret: 'gateway-secret',
  username: 'integracao',
  password: 'integracao-pwd',
  apiKey: 'fake-api-key',
  staticToken: 'fake-static-token',
  basicUser: 'basic-user',
  basicPassword: 'basic-pwd',
} as const;

export interface FakeUpstreamOptions {
  /** Number of generated colaboradores (default 50). */
  colaboradores?: number;
  /** Requires authentication on the API routes (default true). */
  requireAuth?: boolean;
  /** Requires authentication to download `/openapi.json` (default false). */
  protectSpec?: boolean;
  /** TTL of the tokens issued by `/oauth/token`, in seconds (default 300). */
  tokenTtlSeconds?: number;
  /** Fixed port (default: random). */
  port?: number;
  /** Listening interface (default 127.0.0.1). */
  host?: string;
  /** Artificial delay of the token endpoint, in ms (useful for concurrency tests). */
  tokenDelayMs?: number;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface Fault {
  status: number;
  times: number;
  delayMs?: number;
  /** Applies only to requests whose path starts with this prefix. */
  pathPrefix?: string;
}

export interface FakeUpstream {
  url: string;
  app: FastifyInstance;
  requests: RecordedRequest[];
  /** Number of requests received at `/oauth/token`. */
  tokenRequests(): number;
  /** Revokes every issued token (simulates expiry). */
  revokeTokens(): void;
  /** Injects faults into the next requests. */
  addFault(fault: Fault): void;
  data: { colaboradores: Colaborador[]; marcacoes: Marcacao[] };
  close(): Promise<void>;
}

function parseBasic(header: string | undefined): [string, string] | undefined {
  if (!header?.startsWith('Basic ')) return undefined;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx < 0) return undefined;
  return [decoded.slice(0, idx), decoded.slice(idx + 1)];
}

/**
 * Fake HR upstream (Brazilian domain fixture). Its routes, payloads and error bodies are upstream
 * content and intentionally stay in Portuguese: the gateway passes them through untranslated.
 */
export async function startFakeUpstream(opts: FakeUpstreamOptions = {}): Promise<FakeUpstream> {
  const requireAuth = opts.requireAuth ?? true;
  const ttl = opts.tokenTtlSeconds ?? 300;
  const colaboradores = generateColaboradores(opts.colaboradores ?? 50);
  const marcacoes = generateMarcacoes(colaboradores);
  const tokens = new Map<string, number>(); // token -> expiresAt (ms)
  const requests: RecordedRequest[] = [];
  const faults: Fault[] = [];
  let tokenRequestCount = 0;

  const app = Fastify({ logger: false });

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );

  const isAuthorized = (req: FastifyRequest): boolean => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7);
      if (token === FAKE_CREDENTIALS.staticToken) return true;
      const exp = tokens.get(token);
      return exp !== undefined && exp > Date.now();
    }
    const basic = parseBasic(auth);
    if (basic) return basic[0] === FAKE_CREDENTIALS.basicUser && basic[1] === FAKE_CREDENTIALS.basicPassword;
    return req.headers['x-api-key'] === FAKE_CREDENTIALS.apiKey;
  };

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (path === '/oauth/token') return;
    const faultIdx = faults.findIndex((f) => !f.pathPrefix || path.startsWith(f.pathPrefix));
    if (faultIdx >= 0) {
      const fault = faults[faultIdx]!;
      fault.times -= 1;
      if (fault.times <= 0) faults.splice(faultIdx, 1);
      if (fault.delayMs) await new Promise((r) => setTimeout(r, fault.delayMs));
      if (fault.status > 0) {
        return reply.code(fault.status).send({ code: 'FAULT', message: `falha injetada ${fault.status}` });
      }
    }
    const isSpec = path === '/openapi.json' || path === '/postman/collection.json';
    const needsAuth = isSpec ? Boolean(opts.protectSpec) : requireAuth;
    if (needsAuth && !isAuthorized(req)) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'token ausente ou inválido' });
    }
  });

  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/oauth/token')) return;
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: req.body });
  });

  app.post('/oauth/token', async (req, reply) => {
    tokenRequestCount += 1;
    if (opts.tokenDelayMs) await new Promise((r) => setTimeout(r, opts.tokenDelayMs));
    const body = (req.body ?? {}) as Record<string, string>;
    const basic = parseBasic(req.headers.authorization);
    const clientId = body.client_id ?? basic?.[0];
    const clientSecret = body.client_secret ?? basic?.[1];
    if (clientId !== FAKE_CREDENTIALS.clientId || clientSecret !== FAKE_CREDENTIALS.clientSecret) {
      return reply.code(401).send({ error: 'invalid_client' });
    }
    if (body.grant_type === 'password') {
      if (body.username !== FAKE_CREDENTIALS.username || body.password !== FAKE_CREDENTIALS.password) {
        return reply.code(400).send({ error: 'invalid_grant' });
      }
    } else if (body.grant_type !== 'client_credentials') {
      return reply.code(400).send({ error: 'unsupported_grant_type' });
    }
    const token = `fake_${randomUUID()}`;
    tokens.set(token, Date.now() + ttl * 1000);
    return { access_token: token, token_type: 'Bearer', expires_in: ttl };
  });

  app.get('/openapi.json', async (req) => {
    const host = req.headers.host ?? 'localhost';
    return rhOpenApiSpec(`http://${host}`);
  });

  // Postman API envelope (`{ collection }`), as returned by api.getpostman.com (ADR-014)
  app.get('/postman/collection.json', async (req) => {
    const host = req.headers.host ?? 'localhost';
    return { collection: rhPostmanCollection(`http://${host}`, { colaboradores, marcacoes }) };
  });

  app.get('/colaboradores', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    let list = colaboradores;
    if (q.unidade_id) list = list.filter((c) => c.unidade_id === q.unidade_id);
    if (q.nome) list = list.filter((c) => c.nome.toLowerCase().includes(q.nome!.toLowerCase()));
    if (q.ativo !== undefined) list = list.filter((c) => String(c.ativo) === q.ativo);
    const page = Math.max(1, Number(q.page ?? 1));
    const size = Math.max(1, Number(q.size ?? 50));
    return { items: list.slice((page - 1) * size, page * size), total: list.length, page, size };
  });

  app.get('/colaboradores/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = colaboradores.find((x) => x.id === id);
    if (!c) return reply.code(404).send({ code: 'NOT_FOUND', message: `colaborador ${id} não encontrado` });
    return c;
  });

  app.get('/escalas', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    if (q.colaborador) {
      const c = colaboradores.find((x) => x.id === q.colaborador);
      return c ? ESCALAS.filter((e) => e.id === c.escala_id) : [];
    }
    return ESCALAS;
  });

  app.get('/marcacoes', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    let list = marcacoes;
    if (q.colaborador) list = list.filter((m) => m.colaborador_id === q.colaborador);
    if (q.desde) list = list.filter((m) => m.data_hora.slice(0, 10) >= q.desde!);
    return list.slice(0, Number(q.limit ?? 100));
  });

  app.post('/marcacoes', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<Marcacao> & { cpf?: string };
    if (!body.colaborador_id || !body.data_hora || !body.tipo) {
      return reply.code(400).send({ code: 'BAD_REQUEST', message: 'colaborador_id, data_hora e tipo são obrigatórios' });
    }
    const colab = colaboradores.find((c) => c.id === body.colaborador_id);
    if (!colab) return reply.code(404).send({ code: 'NOT_FOUND', message: 'colaborador não encontrado' });
    if (body.cpf && body.cpf !== colab.cpf) {
      return reply.code(422).send({ code: 'CPF_MISMATCH', message: 'CPF não confere com o colaborador' });
    }
    const m: Marcacao = {
      id: `mar-${randomUUID().slice(0, 8)}`,
      colaborador_id: body.colaborador_id,
      data_hora: body.data_hora,
      tipo: body.tipo,
      origem: body.origem ?? 'api',
    };
    marcacoes.push(m);
    return reply.code(201).send(m);
  });

  app.delete('/marcacoes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const idx = marcacoes.findIndex((m) => m.id === id);
    if (idx < 0) return reply.code(404).send({ code: 'NOT_FOUND', message: `marcação ${id} não encontrada` });
    marcacoes.splice(idx, 1);
    return reply.code(204).send();
  });

  // Echo (security, F11.1): returns the received headers and tries to leak sensitive headers.
  app.get('/debug/eco/:valor', async (req, reply) => {
    reply.header('set-cookie', 'sessao=segredo-do-upstream; HttpOnly');
    reply.header('x-internal-token', 'token-interno-do-upstream');
    return { valor: (req.params as { valor: string }).valor, query: req.query, headers: req.headers };
  });

  // Batch outside the spec (F8.4): reprocesses marcações by id.
  app.post('/lotes/marcacoes/reprocessar', async (req, reply) => {
    const body = (req.body ?? {}) as { ids?: unknown };
    if (!Array.isArray(body.ids) || !body.ids.every((x) => typeof x === 'string')) {
      return reply.code(400).send({ code: 'BAD_REQUEST', message: 'ids deve ser uma lista de strings' });
    }
    const known = new Set(marcacoes.map((m) => m.id));
    return { recebidas: body.ids.length, processadas: body.ids.filter((id) => known.has(id as string)).length };
  });

  // Endpoint intentionally OUTSIDE the OpenAPI spec (used by manual tools, F7b.1).
  app.get('/relatorios/banco-horas/:colaborador_id', async (req, reply) => {
    const { colaborador_id } = req.params as { colaborador_id: string };
    const q = req.query as Record<string, string | undefined>;
    const c = colaboradores.find((x) => x.id === colaborador_id);
    if (!c) return reply.code(404).send({ code: 'NOT_FOUND', message: 'colaborador não encontrado' });
    const seed = Number(c.matricula);
    return {
      colaborador_id,
      competencia: q.competencia ?? '2026-09',
      saldo_minutos: (seed % 600) - 200,
      creditos_minutos: (seed % 900) + 60,
      debitos_minutos: (seed % 400) + 30,
    };
  });

  const url = await app.listen({ port: opts.port ?? 0, host: opts.host ?? '127.0.0.1' });

  return {
    url,
    app,
    requests,
    tokenRequests: () => tokenRequestCount,
    revokeTokens: () => tokens.clear(),
    addFault: (f) => faults.push({ ...f }),
    data: { colaboradores, marcacoes },
    close: () => app.close(),
  };
}
