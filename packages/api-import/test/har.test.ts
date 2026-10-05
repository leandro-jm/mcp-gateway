import { generateTools, parseSpec } from '@mcp-gateway/openapi-toolgen';
import { FAKE_CREDENTIALS, startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectFormat, ImportError, importHar, parseImportText, type ImportResult } from '../src';
import { ajv, API_HEADERS, call } from './helpers';

type Entry = Record<string, unknown>;

/** Records a real call to the fake upstream as a HAR entry (like the browser devtools export). */
async function record(up: FakeUpstream, method: string, path: string, body?: unknown, opts: { base64?: boolean } = {}): Promise<Entry> {
  const res = await call(`${up.url}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const url = new URL(`${up.url}${path}`);
  return {
    _resourceType: 'fetch',
    request: {
      method,
      url: url.href,
      headers: [
        ...Object.entries(API_HEADERS).map(([name, value]) => ({ name, value })),
        { name: ':authority', value: url.host },
        { name: 'Cookie', value: 'session=s3cr3t-session' },
        { name: 'Accept-Language', value: 'pt-BR' },
      ],
      queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
      ...(body ? { postData: { mimeType: 'application/json', text: JSON.stringify(body) } } : {}),
    },
    response: {
      status: res.status,
      content: {
        mimeType: 'application/json; charset=utf-8',
        ...(opts.base64 ? { text: Buffer.from(res.text).toString('base64'), encoding: 'base64' } : { text: res.text }),
      },
    },
  };
}

function noise(up: FakeUpstream): Entry[] {
  const response = (mimeType: string) => ({ status: 200, content: { mimeType, text: '' } });
  return [
    { _resourceType: 'document', request: { method: 'GET', url: `${up.url}/`, headers: [] }, response: response('text/html') },
    { _resourceType: 'image', request: { method: 'GET', url: `${up.url}/logo.png`, headers: [] }, response: response('image/png') },
    { request: { method: 'GET', url: `${up.url}/assets/app.js`, headers: [] }, response: response('application/javascript') },
    { _resourceType: 'preflight', request: { method: 'OPTIONS', url: `${up.url}/marcacoes`, headers: [] }, response: response('') },
    { _resourceType: 'xhr', request: { method: 'POST', url: 'https://analytics.example.com/collect', headers: [] }, response: response('application/json') },
    { _resourceType: 'fetch', request: { method: 'GET', url: `${up.url}/colaboradores`, headers: [] }, response: { status: 0, content: {} } },
    { request: { method: 'GET', url: 'chrome-extension://abc/x.json', headers: [] }, response: response('application/json') },
  ];
}

describe('HAR import (recorded against the fake HR upstream)', () => {
  let up: FakeUpstream;
  let result: ImportResult;

  beforeAll(async () => {
    up = await startFakeUpstream();
    const entries = [
      await record(up, 'GET', '/colaboradores?size=5&unidade_id=uni-2'),
      await record(up, 'GET', '/colaboradores?size=10'),
      await record(up, 'GET', '/colaboradores/col-00001'),
      await record(up, 'GET', '/colaboradores/col-00002', undefined, { base64: true }),
      await record(up, 'GET', '/escalas'),
      await record(up, 'GET', '/marcacoes?colaborador=col-00001'),
      await record(up, 'POST', '/marcacoes', { colaborador_id: 'col-00001', data_hora: '2026-10-01T08:00:00-03:00', tipo: 'entrada' }),
      await record(up, 'POST', '/marcacoes', { colaborador_id: 'col-00002', data_hora: '2026-10-01T17:00:00-03:00', tipo: 'saida', origem: 'web' }),
      ...noise(up),
    ];
    result = parseImportText(JSON.stringify({ log: { version: '1.2', creator: { name: 'test', version: '1' }, entries } }));
  });
  afterAll(async () => up.close());

  it('CA F13.3: keeps only the recorded API operations', () => {
    expect(result.format).toBe('har');
    expect(Object.entries(result.openapi.paths as Record<string, object>).flatMap(([p, item]) => Object.keys(item).map((m) => `${m.toUpperCase()} ${p}`)).sort()).toEqual([
      'GET /colaboradores',
      'GET /colaboradores/{colaborador_id}',
      'GET /escalas',
      'GET /marcacoes',
      'POST /marcacoes',
    ]);
    expect(result.baseUrlCandidates).toEqual([up.url]);
  });

  it('CA F13.3: noise from other origins is discarded with a warning; credentials are stripped', () => {
    expect(result.warnings.map((w) => w.key).sort()).toEqual(['import.authStripped', 'import.authStripped', 'import.originsDiscarded']);
    expect(result.warnings.find((w) => w.key === 'import.originsDiscarded')!.params).toEqual({ count: 1, origins: 'https://analytics.example.com' });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('s3cr3t-session');
    expect(serialized).not.toContain(FAKE_CREDENTIALS.apiKey);
    expect(serialized).not.toContain(up.data.colaboradores[0]!.cpf);
    expect(result.suggestedCredential).toEqual({ type: 'api_key', in: 'header', name: 'x-api-key' });
  });

  it('merges samples: query params, required body fields and response schemas', () => {
    const paths = result.openapi.paths as Record<string, Record<string, any>>;
    expect(paths['/colaboradores']!.get.parameters.map((p: any) => p.name)).toEqual(['size', 'unidade_id']);
    const body = paths['/marcacoes']!.post.requestBody.content['application/json'].schema;
    expect(body.required).toEqual(['colaborador_id', 'data_hora', 'tipo']);
    expect(Object.keys(body.properties)).toEqual(['colaborador_id', 'data_hora', 'tipo', 'origem']);
    expect(paths['/colaboradores/{colaborador_id}']!.get.responses['200'].content['application/json'].schema.required).toContain('cpf');
  });

  it('generated tools validate real payloads', async () => {
    const tools = Object.fromEntries(generateTools(await parseSpec(result.openapi), { sourceName: 'rh' }).tools.map((t) => [t.name, t]));
    const t = tools.rh_colaboradores_get!;
    const validate = ajv().compile(t.outputSchema!);
    const body = (await call(`${up.url}/colaboradores/col-00009`)).json;
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  });

  it('fails when there is no API request', () => {
    const har = { log: { entries: noise(up).slice(0, 3) } };
    expect(detectFormat(JSON.stringify(har))).toBe('har');
    expect(() => importHar(har)).toThrow(ImportError);
  });
});
