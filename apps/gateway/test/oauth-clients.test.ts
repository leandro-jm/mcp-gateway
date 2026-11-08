import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpClientMetadataFetcher } from '../src/oauth/clients';

describe('CIMD fetcher (F20.6, ADR-003 T17)', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=120' });
        return res.end(JSON.stringify({ client_id: 'x' }));
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/ok' });
        return res.end();
      }
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ pad: 'x'.repeat(10_000) }));
      }
      if (req.url === '/html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html>');
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const fetcher = httpClientMetadataFetcher({ allowPrivate: true, allowedHosts: [] });

  it('reads the document and its max-age', async () => {
    expect(await fetcher(`${base}/ok`)).toEqual({ json: { client_id: 'x' }, maxAgeSeconds: 120 });
  });

  it.each([
    ['a redirect', '/redirect'],
    ['an error status', '/missing'],
    ['a body over 5 KB', '/big'],
    ['a body that is not JSON', '/html'],
  ])('fails on %s', async (_l, path) => {
    await expect(fetcher(`${base}${path}`)).rejects.toThrow();
  });

  it('never reaches private networks unless the platform allows them', async () => {
    const strict = httpClientMetadataFetcher({ allowPrivate: false, allowedHosts: [] });
    await expect(strict(`${base}/ok`)).rejects.toThrow();
  });
});
