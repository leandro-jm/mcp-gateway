import { createServer, type Server } from 'node:http';
import { closeAgents } from '@mcp-gateway/net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CredentialManager } from '../src/proxy/credentials';
import type { HttpRequestSpec, UpstreamCall } from '../src/proxy/types';
import { RestAdapter } from '../src/proxy/rest-adapter';

const KEY = 'sk_live_9f8e7d6c5b4a';

/** Upstreams echo the API key (pagination links, debug fields): it must never reach the agent. */
describe('RestAdapter: credential values are scrubbed from responses', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://x');
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          items: [{ id: 1 }],
          next: `https://api.example.com/items?page=2&api_key=${encodeURIComponent(url.searchParams.get('api_key') ?? '')}`,
          debug: { key: url.searchParams.get('api_key'), auth: req.headers.authorization ?? null },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    server.close();
    await closeAgents();
  });

  const call = (apply: (req: HttpRequestSpec) => void): Promise<unknown> => {
    const credentials = { apply: async (_t: string, _c: string, req: HttpRequestSpec) => (apply(req), null) } as unknown as CredentialManager;
    const adapter = new RestAdapter(credentials);
    return adapter
      .call({
        tenantId: 't1',
        tool: { name: 'items_list', operationRef: { method: 'GET', path: '/items', mapping: { params: [] } } },
        source: { baseUrl, credentialId: 'c1', settings: {} },
        args: {},
        maxResponseBytes: 1024 * 1024,
        network: { allowPrivate: true, allowedHosts: [] },
      } as unknown as UpstreamCall)
      .then((r) => r.body);
  };

  it('API key in the query string, raw and URL-encoded', async () => {
    const body = JSON.stringify(await call((req) => req.url.searchParams.set('api_key', `${KEY}/+=`)));
    expect(body).not.toContain(KEY);
    expect(body).toContain('[credential]');
  });

  it('bearer token echoed back', async () => {
    const body = JSON.stringify(await call((req) => (req.headers.authorization = `Bearer ${KEY}`)));
    expect(body).not.toContain(KEY);
  });
});
