import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_CREDENTIALS, startFakeUpstream, type FakeUpstream } from '../src';

const CPF_RE = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/;

function isValidCpf(cpf: string): boolean {
  const d = cpf.replace(/\D/g, '').split('').map(Number);
  const dv = (n: number) => {
    const sum = d.slice(0, n).reduce((acc, v, i) => acc + v * (n + 1 - i), 0);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === d[9] && dv(10) === d[10];
}

describe('fake HR upstream', () => {
  let up: FakeUpstream;
  beforeAll(async () => {
    up = await startFakeUpstream();
  });
  afterAll(async () => {
    await up.close();
  });

  async function token(): Promise<string> {
    const res = await fetch(`${up.url}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: FAKE_CREDENTIALS.clientId,
        client_secret: FAKE_CREDENTIALS.clientSecret,
      }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  it('requires authentication', async () => {
    const res = await fetch(`${up.url}/colaboradores`);
    expect(res.status).toBe(401);
  });

  it('issues an OAuth2 token and accepts the authenticated call', async () => {
    const t = await token();
    const res = await fetch(`${up.url}/colaboradores?size=5`, { headers: { authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>>; total: number };
    expect(body.items).toHaveLength(5);
    expect(body.total).toBe(50);
    const c = body.items[0]!;
    expect(c.cpf).toMatch(CPF_RE);
    expect(isValidCpf(c.cpf as string)).toBe(true);
    expect(c.email).toContain('@');
    expect(typeof c.salario).toBe('number');
    expect(up.tokenRequests()).toBeGreaterThanOrEqual(1);
  });

  it('accepts api key, static bearer and basic', async () => {
    const basic = Buffer.from(`${FAKE_CREDENTIALS.basicUser}:${FAKE_CREDENTIALS.basicPassword}`).toString('base64');
    for (const headers of <Array<Record<string, string>>>[
      { 'x-api-key': FAKE_CREDENTIALS.apiKey },
      { authorization: `Bearer ${FAKE_CREDENTIALS.staticToken}` },
      { authorization: `Basic ${basic}` },
    ]) {
      const res = await fetch(`${up.url}/escalas`, { headers });
      expect(res.status).toBe(200);
    }
  });

  it('a revoked token stops working', async () => {
    const t = await token();
    up.revokeTokens();
    const res = await fetch(`${up.url}/escalas`, { headers: { authorization: `Bearer ${t}` } });
    expect(res.status).toBe(401);
  });

  it('creates and deletes a marcação, and serves the OpenAPI spec', async () => {
    const headers = { 'x-api-key': FAKE_CREDENTIALS.apiKey, 'content-type': 'application/json' };
    const colab = up.data.colaboradores[0]!;
    const created = await fetch(`${up.url}/marcacoes`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ colaborador_id: colab.id, data_hora: '2026-10-01T08:00:00-03:00', tipo: 'entrada' }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const del = await fetch(`${up.url}/marcacoes/${id}`, { method: 'DELETE', headers: { 'x-api-key': FAKE_CREDENTIALS.apiKey } });
    expect(del.status).toBe(204);

    const spec = (await (await fetch(`${up.url}/openapi.json`)).json()) as { openapi: string; paths: object };
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/colaboradores', '/colaboradores/{id}', '/escalas', '/marcacoes', '/marcacoes/{id}']),
    );
  });

  it('injects faults on demand', async () => {
    up.addFault({ status: 503, times: 1, pathPrefix: '/escalas' });
    const h = { 'x-api-key': FAKE_CREDENTIALS.apiKey };
    expect((await fetch(`${up.url}/escalas`, { headers: h })).status).toBe(503);
    expect((await fetch(`${up.url}/escalas`, { headers: h })).status).toBe(200);
  });
});
