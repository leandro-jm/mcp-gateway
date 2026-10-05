import { describe, expect, it } from 'vitest';
import { filterOperations, importCurl, mergeOpenApi, operationKeys, rebasePaths } from '../src';

const base = {
  openapi: '3.1.0',
  info: { title: 'Base', version: '7' },
  servers: [{ url: 'https://h.io' }],
  paths: {
    '/users': { get: { summary: 'old list', responses: { '200': { description: 'ok' } } }, parameters: [] },
    '/users/{user_id}': { get: { summary: 'old get', responses: { '200': { description: 'ok' } } } },
  },
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas: { User: { type: 'object' } } },
  security: [{ bearerAuth: [] }],
};

const incoming = importCurl(`
curl https://h.io/users -H 'X-API-Key: k'
curl -X POST https://h.io/users -d '{"name":"a"}' -H 'X-API-Key: k'
curl https://h.io/teams/42 -H 'X-API-Key: k'
`).openapi;

describe('mergeOpenApi', () => {
  it('add: appends new operations and keeps existing ones as conflicts', () => {
    const r = mergeOpenApi(base, incoming, 'add');
    expect(r.added.sort()).toEqual(['GET /teams/{team_id}', 'POST /users']);
    expect(r.replaced).toEqual([]);
    expect(r.conflicts).toEqual(['GET /users']);
    expect(r.warnings).toEqual([{ key: 'import.mergeConflict', params: { operation: 'GET /users' } }]);
    expect((r.doc.paths as any)['/users'].get.summary).toBe('old list');
    expect((r.doc.paths as any)['/users'].parameters).toEqual([]);
    expect(operationKeys(r.doc).sort()).toEqual(['GET /teams/{team_id}', 'GET /users', 'GET /users/{user_id}', 'POST /users']);
  });

  it('replace: overwrites existing operations', () => {
    const r = mergeOpenApi(base, incoming, 'replace');
    expect(r.replaced).toEqual(['GET /users']);
    expect(r.conflicts).toEqual([]);
    expect((r.doc.paths as any)['/users'].get.summary).toBeUndefined();
  });

  it('keeps base info and servers; merges components and security', () => {
    const r = mergeOpenApi(base, incoming, 'add');
    expect(r.doc.info).toEqual(base.info);
    expect(r.doc.servers).toEqual(base.servers);
    expect((r.doc.components as any).securitySchemes).toEqual({
      bearerAuth: { type: 'http', scheme: 'bearer' },
      apiKey_x_api_key: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    });
    expect((r.doc.components as any).schemas).toEqual({ User: { type: 'object' } });
    expect(r.doc.security).toEqual([{ bearerAuth: [] }, { apiKey_x_api_key: [] }]);
  });

  it('include selects incoming operations', () => {
    const r = mergeOpenApi(base, incoming, 'add', ['POST /users']);
    expect(r.added).toEqual(['POST /users']);
    expect(r.conflicts).toEqual([]);
    expect(operationKeys(filterOperations(incoming, ['GET /teams/{team_id}']))).toEqual(['GET /teams/{team_id}']);
  });

  it('does not mutate its inputs', () => {
    const snapshot = JSON.stringify(base);
    mergeOpenApi(base, incoming, 'replace');
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe('rebasePaths', () => {
  const doc = importCurl('curl https://h.io/v1/users/7\ncurl https://h.io/v1\ncurl https://h.io/health').openapi;

  it('strips the base URL path prefix', () => {
    const r = rebasePaths(doc, 'https://h.io/v1/');
    expect(Object.keys(r.paths as object).sort()).toEqual(['/', '/health', '/users/{user_id}']);
    expect(r.servers).toEqual([{ url: 'https://h.io/v1' }]);
  });

  it('is a no-op for a base URL without path', () => {
    expect(rebasePaths(doc, 'https://h.io')).toBe(doc);
  });
});
