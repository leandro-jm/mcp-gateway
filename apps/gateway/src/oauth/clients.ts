import { createHash } from 'node:crypto';
import type { NetworkPolicy } from '@mcp-gateway/core';
import type { OAuthClient } from '@mcp-gateway/db';
import { BodyTooLarge, outboundFetch, readLimited } from '@mcp-gateway/net';
import { isClientMetadataUrl, MAX_CLIENT_METADATA_BYTES, OAuthProtocolError, parseClientMetadataDocument } from '@mcp-gateway/oauth';
import type { Redis } from 'ioredis';
import type { Logger } from '../logger';
import type { Repos } from '../services';

const CIMD_TIMEOUT_MS = 5000;
const CACHE_MIN_SECONDS = 60;
const CACHE_MAX_SECONDS = 24 * 3600;
const CACHE_DEFAULT_SECONDS = 3600;

export interface FetchedClientMetadata {
  json: unknown;
  /** `Cache-Control: max-age` of the response, when present. */
  maxAgeSeconds?: number;
}

/** Fetches a Client ID Metadata Document. Throws on any transport, status or format problem. */
export type ClientMetadataFetcher = (url: string) => Promise<FetchedClientMetadata>;

function maxAgeOf(header: string | null): number | undefined {
  if (!header) return undefined;
  if (/\bno-(store|cache)\b/i.test(header)) return 0;
  const m = /\bmax-age=(\d+)/i.exec(header);
  return m ? Number(m[1]) : undefined;
}

/**
 * Fetches CIMD documents through the outbound guard (ADR-003 T1/T17): no redirects, 5 s timeout,
 * 5 KB ceiling and JSON only.
 */
export function httpClientMetadataFetcher(policy: NetworkPolicy): ClientMetadataFetcher {
  return async (url) => {
    const res = await outboundFetch(
      url,
      { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(CIMD_TIMEOUT_MS) },
      policy,
    );
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`client metadata document answered ${res.status}`);
    }
    try {
      const { text } = await readLimited(res, MAX_CLIENT_METADATA_BYTES);
      return { json: JSON.parse(text) as unknown, maxAgeSeconds: maxAgeOf(res.headers.get('cache-control')) };
    } catch (err) {
      if (err instanceof BodyTooLarge || err instanceof SyntaxError) {
        throw new Error('client metadata document is too large or not JSON', { cause: err });
      }
      throw err;
    }
  };
}

const cacheKey = (clientId: string) => `oauth:cimd:${createHash('sha256').update(clientId).digest('hex').slice(0, 32)}`;

/**
 * Turns a `client_id` into a known client (ADR-030): CIMD documents are fetched and stored, then
 * reused while their cache entry lives; DCR clients must have registered. Failures are
 * `invalid_client` errors, shown to the user and never redirected.
 */
export class OAuthClientResolver {
  constructor(
    private readonly repos: Pick<Repos, 'oauth'>,
    private readonly redis: Redis,
    private readonly fetcher: ClientMetadataFetcher,
    private readonly opts: { dcrEnabled: boolean },
    private readonly logger: Logger,
  ) {}

  async resolve(clientId: string): Promise<OAuthClient> {
    if (isClientMetadataUrl(clientId)) return this.resolveCimd(clientId);
    const client = await this.repos.oauth.findClient(clientId);
    if (!client || client.kind !== 'dcr') throw new OAuthProtocolError('invalid_client', 'invalid_client_id', 'client_id');
    if (!this.opts.dcrEnabled) throw new OAuthProtocolError('invalid_client', 'registration_disabled');
    if (client.disabledAt) throw new OAuthProtocolError('invalid_client', 'client_disabled');
    return client;
  }

  private async resolveCimd(clientId: string): Promise<OAuthClient> {
    const known = await this.repos.oauth.findClient(clientId);
    if (known?.disabledAt) throw new OAuthProtocolError('invalid_client', 'client_disabled');
    if (known && (await this.redis.exists(cacheKey(clientId)))) return known;

    let fetched: FetchedClientMetadata;
    try {
      fetched = await this.fetcher(clientId);
    } catch (err) {
      // fail closed: a document that cannot be read now may have changed its redirect URIs
      this.logger.warn({ err: (err as Error).message, host: new URL(clientId).host }, 'oauth: client metadata document unavailable');
      throw new OAuthProtocolError('invalid_client', 'client_unavailable');
    }
    const meta = parseClientMetadataDocument(fetched.json, clientId);
    const client = await this.repos.oauth.upsertCimdClient({
      clientId,
      clientName: meta.clientName,
      clientUri: meta.clientUri ?? null,
      redirectUris: meta.redirectUris,
      applicationType: meta.applicationType,
    });
    const ttl = Math.min(Math.max(fetched.maxAgeSeconds ?? CACHE_DEFAULT_SECONDS, CACHE_MIN_SECONDS), CACHE_MAX_SECONDS);
    await this.redis.set(cacheKey(clientId), '1', 'EX', ttl);
    return client;
  }
}
