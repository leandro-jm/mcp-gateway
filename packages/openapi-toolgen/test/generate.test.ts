import { describe, expect, it } from 'vitest';
import { baseToolName, cleanText, DESCRIPTION_SUFFIX_RESERVE, generateTools, parseSpec, snake, type NormalizedOperation } from '../src';
import { FIXTURES } from './fixtures';

const gen = async (spec: unknown, opts: Partial<Parameters<typeof generateTools>[1]> = {}) =>
  generateTools(await parseSpec(spec), { sourceName: 'rh', ...opts });

const miniSpec = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths,
  ...extra,
});

describe('tool generation', () => {
  it('snapshot of the tools generated from the HR spec', async () => {
    const { tools, skipped } = await gen(FIXTURES['oas-3.1']());
    expect(skipped).toEqual([]);
    expect(tools).toMatchSnapshot();
  });

  it('the 3 spec versions generate exactly the same tools (same spec_hash)', async () => {
    const [a, b, c] = await Promise.all([gen(FIXTURES['swagger-2.0']()), gen(FIXTURES['oas-3.0']()), gen(FIXTURES['oas-3.1']())]);
    expect(a.tools.map((t) => t.specHash)).toEqual(c.tools.map((t) => t.specHash));
    expect(b.tools.map((t) => t.specHash)).toEqual(c.tools.map((t) => t.specHash));
  });

  it('{source}_{resource}_{verb} names, annotations and no effect suffix in the description', async () => {
    const { tools } = await gen(FIXTURES['oas-3.1']());
    const byKey = Object.fromEntries(tools.map((t) => [t.operationKey, t]));
    expect(tools.map((t) => t.name).sort()).toEqual([
      'rh_colaborador_get',
      'rh_colaboradores_list',
      'rh_escalas_list',
      'rh_marcacao_create',
      'rh_marcacao_delete',
      'rh_marcacoes_list',
    ]);
    expect(byKey['GET /colaboradores']!.annotations).toEqual({ readOnlyHint: true });
    expect(byKey['DELETE /marcacoes/{id}']!.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(byKey['GET /colaboradores']!.description).toBe(
      'Lista colaboradores. Retorna a lista paginada de colaboradores. Permite filtrar por unidade e por nome.',
    );
    // the effect suffix is appended, localized, by the gateway at tools/list time (ADR-012)
    expect(byKey['POST /marcacoes']!.description).toBe('Registra uma marcação de ponto. Registra uma marcação de entrada ou saída para o colaborador.');
    expect(byKey['DELETE /marcacoes/{id}']!.description).toBe('Remove uma marcação.');
  });

  it('flattened input: path, query, header (no auth) and body without readOnly', async () => {
    const { tools } = await gen(FIXTURES['oas-3.1']());
    const create = tools.find((t) => t.operationKey === 'POST /marcacoes')!;
    const props = create.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(['x_request_id', 'colaborador_id', 'cpf', 'data_hora', 'tipo', 'origem']);
    expect(props).not.toHaveProperty('id');
    expect(create.inputSchema.required).toEqual(['colaborador_id', 'data_hora', 'tipo']);
    expect(create.inputSchema.additionalProperties).toBe(false);
    expect(create.operationRef.mapping).toEqual({
      params: [{ field: 'x_request_id', in: 'header', name: 'X-Request-Id' }],
      body: { mode: 'flatten', fields: ['colaborador_id', 'cpf', 'data_hora', 'tipo', 'origem'], contentType: 'application/json' },
      response: { contentType: 'application/json' },
    });
    // array response is wrapped in { items }
    const escalas = tools.find((t) => t.operationKey === 'GET /escalas')!;
    expect(escalas.operationRef.mapping?.response?.wrap).toBe('items');
    expect(escalas.outputSchema?.required).toEqual(['items']);
  });

  it('excludes auth headers and api key parameters', async () => {
    const { tools } = await gen(
      miniSpec(
        {
          '/x': {
            get: {
              operationId: 'getX',
              parameters: [
                { name: 'Authorization', in: 'header', schema: { type: 'string' } },
                { name: 'X-Tenant-Key', in: 'header', schema: { type: 'string' } },
                { name: 'api_key', in: 'query', schema: { type: 'string' } },
                { name: 'sessao', in: 'cookie', schema: { type: 'string' } },
                { name: 'q', in: 'query', schema: { type: 'string' } },
              ],
              responses: { '200': { description: 'ok' } },
            },
          },
        },
        {
          components: {
            securitySchemes: {
              k: { type: 'apiKey', in: 'header', name: 'X-Tenant-Key' },
              q: { type: 'apiKey', in: 'query', name: 'api_key' },
            },
          },
        },
      ),
    );
    expect(Object.keys(tools[0]!.inputSchema.properties as object)).toEqual(['q']);
    expect(tools[0]!.outputSchema).toBeNull();
  });

  it('body with a name collision goes into the body field', async () => {
    const { tools } = await gen(
      miniSpec({
        '/itens/{id}': {
          put: {
            operationId: 'updateItem',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, nome: { type: 'string' } } } } },
            },
            responses: { '204': { description: 'ok' } },
          },
        },
      }),
    );
    const t = tools[0]!;
    expect(t.name).toBe('rh_item_update');
    expect(t.annotations).toEqual({ readOnlyHint: false, idempotentHint: true });
    expect(t.inputSchema.required).toEqual(['id', 'body']);
    expect(t.operationRef.mapping?.body).toEqual({ mode: 'field', field: 'body', contentType: 'application/json' });
  });

  it('skips deprecated and x-mcp-ignore; honors x-mcp-name and x-mcp-description', async () => {
    const { tools, skipped } = await gen(
      miniSpec({
        '/a': { get: { operationId: 'listA', deprecated: true, responses: {} } },
        '/b': { get: { operationId: 'listB', 'x-mcp-ignore': true, responses: {} } },
        '/c': {
          get: {
            operationId: 'listC',
            'x-mcp-name': 'consultar_cs',
            'x-mcp-description': 'Consulta **Cs** cadastrados',
            responses: {},
          },
        },
      }),
    );
    expect(skipped).toEqual([
      { operationKey: 'GET /a', reason: 'deprecated' },
      { operationKey: 'GET /b', reason: 'x-mcp-ignore' },
    ]);
    expect(tools.map((t) => [t.name, t.description])).toEqual([['consultar_cs', 'Consulta Cs cadastrados.']]);
  });

  it('names without operationId, 64-char limit and deterministic collisions', async () => {
    const long = '/' + Array.from({ length: 12 }, (_, i) => `recurso_muito_comprido_${i}`).join('/');
    const spec = miniSpec({
      '/unidades/{id}/colaboradores': { get: { responses: {} } },
      '/unidades/{id}': { get: { responses: {} }, delete: { responses: {} } },
      [long]: { post: { responses: {} } },
      '/dup1': { get: { operationId: 'listDup', responses: {} } },
      '/dup2': { get: { operationId: 'listDup2', 'x-mcp-name': 'rh_dup_list', responses: {} } },
    });
    const first = (await gen(spec)).tools;
    const names = first.map((t) => t.name);
    expect(names).toContain('rh_unidades_colaboradores_list');
    expect(names).toContain('rh_unidades_get');
    expect(names).toContain('rh_unidades_delete');
    expect(names.every((n) => n.length <= 64 && /^[a-z][a-z0-9_]*$/.test(n))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    // stable: generating again (with the spec in another order) yields the same names
    const reversed = miniSpec(Object.fromEntries(Object.entries(spec.paths).reverse()));
    expect((await gen(reversed)).tools.map((t) => t.name)).toEqual(names);
  });

  it('limits depth and turns a complex oneOf into a description', async () => {
    const deep = (n: number): Record<string, unknown> =>
      n === 0 ? { type: 'string' } : { type: 'object', properties: { nivel: deep(n - 1) } };
    const { tools } = await gen(
      miniSpec({
        '/x': {
          post: {
            operationId: 'createX',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      profundo: deep(8),
                      forma: { oneOf: [{ type: 'string' }, { type: 'integer' }, { type: 'boolean' }, { type: 'number' }, { type: 'array', items: { type: 'string' } }] },
                      simples: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
                    },
                  },
                },
              },
            },
            responses: {},
          },
        },
      }),
      { maxDepth: 3 },
    );
    const props = tools[0]!.inputSchema.properties as Record<string, any>;
    expect(props.profundo.properties.nivel.properties.nivel).toEqual({ type: 'object', description: '(nested structure omitted)' });
    expect(props.forma).toEqual({ description: 'Accepts one of: string | integer | boolean | number | array.' });
    expect(props.simples.oneOf).toHaveLength(2);
  });

  it('truncates long descriptions, reserving room for the gateway effect suffix', async () => {
    const { tools } = await gen(
      miniSpec({ '/x': { get: { operationId: 'getX', summary: 'Resumo', description: 'palavra '.repeat(400), responses: {} } } }),
    );
    expect(tools[0]!.description.length).toBeLessThanOrEqual(1024 - DESCRIPTION_SUFFIX_RESERVE);
    expect(tools[0]!.description).toMatch(/…$/);
  });

  it('utilities', () => {
    expect(snake('listColaboradoresAtivos')).toBe('list_colaboradores_ativos');
    expect(snake('X-Request-Id')).toBe('x_request_id');
    expect(snake('Ação Válida')).toBe('acao_valida');
    expect(cleanText('# Título\n\n**negrito** e [link](http://x) `code` <i>html</i>')).toBe('Título negrito e link code html');
    const op = { key: 'GET /x', method: 'GET', path: '/x', operationId: 'searchPessoas', tags: [], deprecated: false, extensions: {}, parameters: [], responses: [] } as NormalizedOperation;
    expect(baseToolName('Minha Fonte', op)).toBe('minha_fonte_pessoas_search');
  });
});
