import { generateTools, parseSpec, type GeneratedTool } from '@mcp-gateway/openapi-toolgen';
import { FAKE_CREDENTIALS, startFakeUpstream, type FakeUpstream } from '@mcp-gateway/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectFormat, ImportError, importPostman, parseImportText, type ImportResult } from '../src';
import { ajv, call } from './helpers';

const json = (body: unknown) => JSON.stringify(body, null, 2);

/** Postman v2.1 collection of the fake HR upstream, with example responses recorded from it. */
async function rhCollection(up: FakeUpstream) {
  const list = await call(`${up.url}/colaboradores?size=3`);
  const one = await call(`${up.url}/colaboradores/col-00001`);
  const created = await call(`${up.url}/marcacoes`, {
    method: 'POST',
    body: JSON.stringify({ colaborador_id: 'col-00003', data_hora: '2026-10-01T08:00:00-03:00', tipo: 'entrada' }),
  });
  const jsonHeader = [{ key: 'Content-Type', value: 'application/json' }];
  return {
    info: {
      _postman_id: '7f9c1f2e-0000-4000-8000-000000000001',
      name: 'RH Fake API',
      description: 'Fake HR API',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: {
      type: 'apikey',
      apikey: [
        { key: 'key', value: 'x-api-key', type: 'string' },
        { key: 'value', value: FAKE_CREDENTIALS.apiKey, type: 'string' },
        { key: 'in', value: 'header', type: 'string' },
      ],
    },
    event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: ['pm.environment.set("t", Date.now())'] } }],
    variable: [{ key: 'baseUrl', value: up.url }, { key: 'colaboradorId', value: 'col-00001' }],
    item: [
      {
        name: 'Colaboradores',
        item: [
          {
            name: 'Listar colaboradores',
            request: {
              method: 'GET',
              header: [{ key: 'Accept', value: 'application/json' }],
              url: {
                raw: '{{baseUrl}}/colaboradores?size=20&unidade_id=uni-1&nome=ana',
                host: ['{{baseUrl}}'],
                path: ['colaboradores'],
                query: [
                  { key: 'size', value: '20' },
                  { key: 'unidade_id', value: 'uni-1' },
                  { key: 'nome', value: 'ana', disabled: true },
                ],
              },
            },
            response: [{ name: 'ok', code: 200, header: jsonHeader, body: json(list.json) }],
          },
          {
            name: 'Buscar colaborador',
            request: {
              method: 'GET',
              url: {
                raw: '{{baseUrl}}/colaboradores/:id',
                host: ['{{baseUrl}}'],
                path: ['colaboradores', ':id'],
                variable: [{ key: 'id', value: 'col-00001', description: 'Employee id' }],
              },
              description: 'Returns one employee.',
            },
            response: [
              { name: 'ok', code: 200, header: jsonHeader, body: json(one.json) },
              { name: 'not found', code: 404, header: jsonHeader, body: json({ code: 'NOT_FOUND', message: 'x' }) },
            ],
          },
        ],
      },
      {
        name: 'Marcações',
        item: [
          {
            name: 'Registrar marcação',
            request: {
              method: 'POST',
              header: jsonHeader,
              body: {
                mode: 'raw',
                raw: '{\n  "colaborador_id": "{{colaboradorId}}",\n  "data_hora": "2026-10-01T08:00:00-03:00",\n  "tipo": "entrada"\n}',
                options: { raw: { language: 'json' } },
              },
              url: '{{baseUrl}}/marcacoes',
            },
            response: [{ name: 'created', code: 201, header: jsonHeader, body: json(created.json) }],
          },
          {
            name: 'Remover marcação',
            request: { method: 'DELETE', url: { raw: '{{baseUrl}}/marcacoes/:id', variable: [{ key: 'id' }] } },
          },
          {
            name: 'Consulta GraphQL',
            request: { method: 'POST', body: { mode: 'graphql', graphql: { query: '{ a }' } }, url: '{{baseUrl}}/graphql' },
          },
        ],
      },
    ],
  };
}

describe('Postman v2.1 import (fake HR upstream)', () => {
  let up: FakeUpstream;
  let collection: Awaited<ReturnType<typeof rhCollection>>;
  let result: ImportResult;
  let tools: Record<string, GeneratedTool>;

  beforeAll(async () => {
    up = await startFakeUpstream();
    collection = await rhCollection(up);
    result = parseImportText(JSON.stringify(collection));
    tools = Object.fromEntries(generateTools(await parseSpec(result.openapi), { sourceName: 'rh' }).tools.map((t) => [t.name, t]));
  });
  afterAll(async () => up.close());

  it('detects the format and resolves the base URL variable', () => {
    expect(result.format).toBe('postman');
    expect(result.baseUrlCandidates).toEqual([up.url]);
    expect(result.suggestedName).toBe('rh_fake_api');
  });

  it('maps folders, path variables, disabled query params and descriptions', () => {
    const paths = result.openapi.paths as Record<string, Record<string, any>>;
    expect(Object.keys(paths).sort()).toEqual(['/colaboradores', '/colaboradores/{id}', '/marcacoes', '/marcacoes/{id}']);
    const get = paths['/colaboradores/{id}']!.get;
    expect(get.tags).toEqual(['Colaboradores']);
    expect(get.summary).toBe('Buscar colaborador');
    expect(get.description).toBe('Returns one employee.');
    expect(get.parameters).toEqual([{ name: 'id', in: 'path', required: true, description: 'Employee id', schema: { type: 'string' } }]);
    expect(Object.keys(get.responses)).toEqual(['200', '404']);
    expect(paths['/colaboradores']!.get.parameters.map((p: any) => p.name)).toEqual(['size', 'unidade_id']);
  });

  it('turns collection auth into a security scheme without the secret', () => {
    expect(result.suggestedCredential).toEqual({ type: 'api_key', in: 'header', name: 'x-api-key' });
    expect((result.openapi.components as any).securitySchemes).toEqual({ apiKey_x_api_key: { type: 'apiKey', in: 'header', name: 'x-api-key' } });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(FAKE_CREDENTIALS.apiKey);
    // example values (PII) are not kept
    const colab = up.data.colaboradores[0]!;
    expect(serialized).not.toContain(colab.cpf);
    expect(serialized).not.toContain(colab.nome);
  });

  it('warns about skipped GraphQL requests and ignored scripts', () => {
    expect(result.warnings.map((w) => w.key).sort()).toEqual(['import.authStripped', 'import.graphqlSkipped', 'import.postmanScriptsIgnored']);
  });

  it('CA F13.2: output schemas validate real payloads of other records', async () => {
    const validator = ajv();
    const check = async (tool: string, url: string) => {
      const t = tools[tool]!;
      const body = (await call(url)).json;
      const wrap = t.operationRef.mapping?.response?.wrap;
      const validate = validator.compile(t.outputSchema!);
      expect(validate(wrap ? { [wrap]: body } : body), JSON.stringify(validate.errors)).toBe(true);
    };
    await check('rh_colaboradores_list', `${up.url}/colaboradores?size=50`);
    await check('rh_colaboradores_get', `${up.url}/colaboradores/col-00007`);
  });

  it('CA F13.2: input schema accepts real arguments and the upstream accepts them', async () => {
    const tool = tools.rh_marcacoes_create!;
    const args = { colaborador_id: up.data.colaboradores[4]!.id, data_hora: '2026-10-02T08:00:00-03:00', tipo: 'saida' };
    const validate = ajv().compile(tool.inputSchema);
    expect(validate(args), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...args, inexistente: 1 })).toBe(false);
    expect((await call(`${up.url}/marcacoes`, { method: 'POST', body: JSON.stringify(args) })).status).toBe(201);
  });
});

describe('Postman variants', () => {
  it('v2.0 auth objects, string URLs and unresolved host variables', () => {
    const r = importPostman({
      info: { name: 'Legacy', schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json' },
      item: [
        {
          name: 'Create item',
          request: {
            method: 'POST',
            url: '{{host}}/items/{{itemId}}?verbose=true',
            auth: { type: 'bearer', bearer: { token: 'tok-abc' } },
            body: { mode: 'raw', raw: '{"qty": {{qty}}, "name": "{{name}}"}' },
          },
        },
      ],
    });
    expect(Object.keys(r.openapi.paths as object)).toEqual(['/items/{item_id}']);
    expect(r.baseUrlCandidates).toEqual([]);
    expect(r.warnings.map((w) => w.key)).toEqual(['import.unresolvedVariable', 'import.authStripped', 'import.noBaseUrl']);
    expect(r.suggestedCredential).toEqual({ type: 'bearer_static' });
    const body = (r.openapi.paths as any)['/items/{item_id}'].post.requestBody.content['application/json'].schema;
    expect(body).toEqual({ type: 'object', properties: { qty: { type: 'null' }, name: { type: 'string' } } });
    expect(JSON.stringify(r)).not.toContain('tok-abc');
  });

  it('unwraps the Postman API envelope', () => {
    const text = JSON.stringify({ collection: { info: { _postman_id: 'x', name: 'Wrapped' }, item: [{ name: 'a', request: 'https://h.io/a' }] } });
    expect(detectFormat(text)).toBe('postman');
    expect(parseImportText(text).baseUrlCandidates).toEqual(['https://h.io']);
  });

  it('urlencoded and formdata bodies; file bodies are skipped', () => {
    const r = importPostman({
      info: { _postman_id: 'x', name: 'Forms' },
      item: [
        { name: 'login', request: { method: 'POST', url: 'https://h.io/login', body: { mode: 'urlencoded', urlencoded: [{ key: 'user', value: 'a' }, { key: 'n', value: '3' }] } } },
        { name: 'upload', request: { method: 'POST', url: 'https://h.io/up', body: { mode: 'formdata', formdata: [{ key: 'f', type: 'file', src: '/tmp/a' }] } } },
        { name: 'raw file', request: { method: 'PUT', url: 'https://h.io/blob', body: { mode: 'file', file: { src: '/tmp/a' } } } },
      ],
    });
    const paths = r.openapi.paths as any;
    expect(paths['/login'].post.requestBody.content['application/x-www-form-urlencoded'].schema.properties).toEqual({ user: { type: 'string' }, n: { type: 'integer' } });
    expect(paths['/up'].post.requestBody.content['multipart/form-data'].schema.properties).toEqual({ f: { type: 'string', format: 'binary' } });
    expect(paths['/blob']).toBeUndefined();
    expect(r.warnings.map((w) => w.key)).toEqual(['import.fileBodySkipped']);
  });

  it('rejects collection v1', () => {
    expect(() => parseImportText(JSON.stringify({ id: 'x', name: 'old', order: [], requests: [] }))).toThrow(ImportError);
    try {
      importPostman({ id: 'x', name: 'old', order: [], requests: [] });
    } catch (err) {
      expect((err as ImportError).msg.key).toBe('import.postmanV1Unsupported');
    }
  });
});
