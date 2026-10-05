import type { OperationRef } from '@mcp-gateway/core';
import { describe, expect, it } from 'vitest';
import { buildHttpRequest, encodePathParam } from '../src/proxy/request-builder';
import { errorPayload, upstreamToToolResult } from '../src/proxy/result';
import type { SnapshotTool } from '../src/registry/snapshot';

const op = (method: string, path: string, mapping: OperationRef['mapping']): OperationRef => ({ method, path, mapping });

describe('MCP → REST translator: request building', () => {
  it('GET with an encoded path param and query (explode/csv arrays, objects as JSON)', () => {
    const req = buildHttpRequest(
      'http://up.local/api/',
      op('GET', '/unidades/{id}/colaboradores', {
        params: [
          { field: 'id', in: 'path', name: 'id' },
          { field: 'tags', in: 'query', name: 'tag', explode: true },
          { field: 'ids', in: 'query', name: 'ids', explode: false },
          { field: 'filtro', in: 'query', name: 'filtro' },
          { field: 'ausente', in: 'query', name: 'ausente' },
        ],
      }),
      { id: 'a/b c', tags: ['x', 'y'], ids: [1, 2, 3], filtro: { ativo: true } },
    );
    expect(req.method).toBe('GET');
    expect(req.url.pathname).toBe('/api/unidades/a%2Fb%20c/colaboradores');
    expect(req.url.searchParams.getAll('tag')).toEqual(['x', 'y']);
    expect(req.url.searchParams.get('ids')).toBe('1,2,3');
    expect(req.url.searchParams.get('filtro')).toBe('{"ativo":true}');
    expect(req.url.searchParams.has('ausente')).toBe(false);
    expect(req.body).toBeUndefined();
  });

  it('path traversal in a path param does not escape the resource', () => {
    expect(() => encodePathParam('..')).toThrow(/invalid/);
    expect(() => encodePathParam('.')).toThrow(/invalid/);
    expect(() => encodePathParam('../admin')).toThrow(/invalid/);
    expect(() => encodePathParam('a\\..\\b')).toThrow(/invalid/);
    expect(() => encodePathParam('a\nb')).toThrow(/invalid/);
    expect(encodePathParam('2026/10/01')).toBe('2026%2F10%2F01');
    expect(encodePathParam('v1.2')).toBe('v1.2');
    const del = op('DELETE', '/marcacoes/{id}', { params: [{ field: 'id', in: 'path', name: 'id' }] });
    expect(() => buildHttpRequest('http://up.local', del, { id: '..' })).toThrow(/invalid/);
    expect(() => buildHttpRequest('http://up.local', del, { id: '%2E%2E' })).not.toThrow();
    expect(buildHttpRequest('http://up.local', del, { id: '%2E%2E' }).url.pathname).toBe('/marcacoes/%252E%252E');
    expect(() => buildHttpRequest('http://up.local', del, { id: '../../admin' })).toThrow(/invalid/);
    expect(buildHttpRequest('http://up.local', del, { id: 'a/b' }).url.pathname).toBe('/marcacoes/a%2Fb');
    expect(() => buildHttpRequest('http://up.local', op('GET', '/x/{id}', { params: [{ field: 'id', in: 'path', name: 'id' }] }), {})).toThrow(/missing required parameter: id/);
  });

  it('POST with a flattened body and header; PUT with the body in a field', () => {
    const post = buildHttpRequest(
      'http://up.local',
      op('POST', '/marcacoes', {
        params: [{ field: 'x_request_id', in: 'header', name: 'X-Request-Id' }],
        body: { mode: 'flatten', fields: ['colaborador_id', 'tipo', 'origem'], contentType: 'application/json' },
      }),
      { x_request_id: 'r1', colaborador_id: 'c1', tipo: 'entrada' },
    );
    expect(post.headers['x-request-id']).toBe('r1');
    expect(post.headers['content-type']).toBe('application/json');
    expect(JSON.parse(post.body!)).toEqual({ colaborador_id: 'c1', tipo: 'entrada' });

    const put = buildHttpRequest(
      'http://up.local',
      op('PUT', '/itens/{id}', { params: [{ field: 'id', in: 'path', name: 'id' }], body: { mode: 'field', field: 'body', contentType: 'application/json' } }),
      { id: '7', body: [{ a: 1 }] },
    );
    expect(put.method).toBe('PUT');
    expect(JSON.parse(put.body!)).toEqual([{ a: 1 }]);

    const form = buildHttpRequest(
      'http://up.local',
      op('PATCH', '/f', { params: [], body: { mode: 'flatten', fields: ['a', 'b'], contentType: 'application/x-www-form-urlencoded' } }),
      { a: 'x y', b: 2 },
    );
    expect(form.body).toBe('a=x+y&b=2');
  });

  it('rejects a header with a line break (injection)', () => {
    expect(() =>
      buildHttpRequest('http://up.local', op('GET', '/x', { params: [{ field: 'h', in: 'header', name: 'X-H' }] }), { h: 'a\r\nX-Evil: 1' }),
    ).toThrow(/invalid header/);
  });
});

describe('response mapping', () => {
  const tool = (wrap?: 'items'): SnapshotTool =>
    ({
      name: 't',
      outputSchema: { type: 'object' },
      operationRef: { method: 'GET', path: '/x', mapping: { params: [], response: wrap ? { wrap } : {} } },
    }) as unknown as SnapshotTool;
  const res = (status: number, body: unknown) => ({ status, body, contentType: 'application/json', bytes: 1, durationMs: 1, attempts: 1 });

  it('2xx → JSON text + structuredContent (wrapped for arrays)', () => {
    expect(upstreamToToolResult(tool(), res(200, { a: 1 }))).toEqual({ content: [{ type: 'text', text: '{"a":1}' }], structuredContent: { a: 1 } });
    expect(upstreamToToolResult(tool('items'), res(200, [1, 2])).structuredContent).toEqual({ items: [1, 2] });
    expect(upstreamToToolResult(tool(), res(204, '')).content[0]).toEqual({ type: 'text', text: 'Operation completed (HTTP 204, no content).' });
    expect(upstreamToToolResult(tool(), res(204, ''), { locale: 'pt-BR' }).content[0]).toEqual({
      type: 'text',
      text: 'Operação concluída (HTTP 204, sem conteúdo).',
    });
  });

  it('4xx → error with a useful message; 5xx → error with the status code', () => {
    const notFound = upstreamToToolResult(tool(), res(404, { code: 'NOT_FOUND', message: 'colaborador x não encontrado' }));
    expect(notFound.isError).toBe(true);
    // upstream text is passed through untranslated; the gateway hint follows the locale
    expect(errorPayload(notFound)).toMatchObject({
      error: 'UPSTREAM_CLIENT_ERROR',
      status: 404,
      message: 'colaborador x não encontrado',
      hint: 'Resource not found; check the identifiers you provided.',
    });
    expect(errorPayload(upstreamToToolResult(tool(), res(404, {}), { locale: 'es' }))).toMatchObject({
      message: 'el upstream respondió HTTP 404',
      hint: 'Recurso no encontrado; verifique los identificadores informados.',
    });
    const server = upstreamToToolResult(tool(), res(503, { message: 'stack trace interno em db.js:42' }));
    expect(errorPayload(server)).toEqual({ error: 'UPSTREAM_ERROR', status: 503, message: 'upstream service error (HTTP 503)' });
    expect(errorPayload(upstreamToToolResult(tool(), res(503, {}), { locale: 'pt-BR' })).message).toBe('erro no serviço upstream (HTTP 503)');
  });
});
