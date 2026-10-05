import { describe, expect, it } from 'vitest';
import { parseSpec, SpecError, toJsonSchema } from '../src';
import { FIXTURES } from './fixtures';

describe('spec normalization', () => {
  it('Swagger 2.0, OAS 3.0 and OAS 3.1 normalize to the same internal model', async () => {
    const [v2, v30, v31] = await Promise.all([
      parseSpec(FIXTURES['swagger-2.0']()),
      parseSpec(FIXTURES['oas-3.0']()),
      parseSpec(FIXTURES['oas-3.1']()),
    ]);
    expect([v2.specVersion, v30.specVersion, v31.specVersion]).toEqual(['2.0', '3.0', '3.1']);
    const strip = ({ specVersion: _s, ...rest }: typeof v2) => rest;
    expect(strip(v2)).toEqual(strip(v31));
    expect(strip(v30)).toEqual(strip(v31));
  });

  it('extracts operations, parameters, body and responses', async () => {
    const spec = await parseSpec(FIXTURES['oas-3.1']());
    expect(spec.operations.map((o) => o.key)).toEqual([
      'GET /colaboradores',
      'GET /colaboradores/{id}',
      'GET /escalas',
      'GET /marcacoes',
      'POST /marcacoes',
      'DELETE /marcacoes/{id}',
    ].sort());
    expect(spec.servers).toEqual(['http://localhost']);
    const create = spec.operations.find((o) => o.key === 'POST /marcacoes')!;
    expect(create.parameters).toEqual([
      { name: 'X-Request-Id', in: 'header', required: false, description: 'Id de idempotência opcional', schema: { type: 'string' } },
    ]);
    expect(create.requestBody?.required).toBe(true);
    expect(create.requestBody?.contentType).toBe('application/json');
    const created = create.responses.find((r) => r.status === '201')!;
    expect((created.schema?.properties as Record<string, unknown>).origem).toEqual({ type: ['string', 'null'] });
    expect(spec.securitySchemes.apiKey).toEqual({ type: 'apiKey', in: 'header', name: 'X-API-Key' });
  });

  it('rejects unsupported versions and external $refs', async () => {
    await expect(parseSpec({ openapi: '4.0.0', paths: {} })).rejects.toBeInstanceOf(SpecError);
    await expect(parseSpec({ swagger: '1.2' })).rejects.toBeInstanceOf(SpecError);
    await expect(parseSpec({ swagger: '1.2' })).rejects.toMatchObject({
      msg: { key: 'toolgen.unsupportedSpecVersion' },
      message: 'unsupported spec version (expected swagger 2.0 or openapi 3.0/3.1)',
    });
    await expect(
      parseSpec({
        openapi: '3.1.0',
        info: { title: 'x', version: '1' },
        paths: { '/x': { get: { responses: { '200': { $ref: 'http://169.254.169.254/latest' } } } } },
      }),
    ).rejects.toMatchObject({ msg: { key: 'toolgen.externalRef', params: { ref: 'http://169.254.169.254/latest' } } });
  });

  it('converts quirks of older versions to JSON Schema', () => {
    expect(toJsonSchema({ type: 'integer', minimum: 0, exclusiveMinimum: true }, '3.0')).toEqual({
      type: 'integer',
      exclusiveMinimum: 0,
    });
    expect(toJsonSchema({ type: 'file' }, '2.0')).toEqual({ type: 'string', format: 'binary' });
    expect(toJsonSchema({ type: 'string', example: 'abc', xml: { name: 'x' }, 'x-foo': 1 }, '3.0')).toEqual({
      type: 'string',
      examples: ['abc'],
    });
  });

  it('keeps circular references without blowing up', async () => {
    const spec = await parseSpec({
      openapi: '3.1.0',
      info: { title: 'x', version: '1' },
      paths: {
        '/nodes': {
          get: {
            responses: {
              '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
            },
          },
        },
      },
      components: {
        schemas: {
          Node: { type: 'object', properties: { id: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } },
        },
      },
    });
    expect(() => JSON.stringify(spec)).not.toThrow();
  });
  it('a schema shared through many paths is rejected instead of expanding exponentially', async () => {
    const schemas: Record<string, unknown> = { L0: { type: 'string' } };
    for (let i = 1; i <= 30; i++) schemas[`L${i}`] = { type: 'object', properties: { a: { $ref: `#/components/schemas/L${i - 1}` }, b: { $ref: `#/components/schemas/L${i - 1}` } } };
    const spec = {
      openapi: '3.0.3',
      info: { title: 'bomb', version: '1' },
      paths: { '/x': { get: { operationId: 'x', responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/L30' } } } } } } } },
      components: { schemas },
    };
    const t0 = Date.now();
    await expect(parseSpec(spec)).rejects.toMatchObject({ msg: { key: 'toolgen.schemaTooLarge' } });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
