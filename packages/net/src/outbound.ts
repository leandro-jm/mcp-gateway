import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { assertOutboundUrl, isIP, isPrivateAddress, OutboundBlocked, resolvesToPrivate, type NetworkPolicy } from '@mcp-gateway/core';
import { Agent, buildConnector, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

export { OutboundBlocked };
export type { NetworkPolicy };

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * DNS lookup that rejects private addresses at connect time (anti DNS rebinding:
 * the host may resolve to a public IP at validation and to a private one at connect).
 */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: { all?: boolean; family?: number } & Record<string, unknown>, cb: LookupCallback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err, []);
      const list = addresses as LookupAddress[];
      if (!allowPrivate) {
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad) return cb(Object.assign(resolvesToPrivate(bad.address), { code: 'EBLOCKED' }), []);
      }
      if (options.all) return cb(null, list);
      const first = list[0];
      if (!first) return cb(Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }), []);
      cb(null, first.address, first.family);
    });
  };
}

/**
 * Connector that also checks IP literal hosts: the socket connects to them directly, without
 * calling `lookup`, so `guardedLookup` alone never sees them.
 */
export function guardedConnector(allowPrivate: boolean): buildConnector.connector {
  const connect = buildConnector({ lookup: guardedLookup(allowPrivate) as never });
  return (opts, cb) => {
    const host = opts.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && isIP(host) && isPrivateAddress(host)) return cb(resolvesToPrivate(host), null);
    connect(opts, cb);
  };
}

const agents = new Map<string, Agent>();

function agentFor(policy: NetworkPolicy): Agent {
  const key = policy.allowPrivate ? 'private' : 'public';
  let a = agents.get(key);
  if (!a) {
    a = new Agent({ connect: guardedConnector(policy.allowPrivate), keepAliveTimeout: 10_000 });
    agents.set(key, a);
  }
  return a;
}

export type OutboundInit = Omit<UndiciRequestInit, 'dispatcher'>;

/**
 * `fetch` for outbound traffic (upstreams, specs, tokens, webhooks): validates the URL against the
 * policy (protocol, allowlist, private IP literal) and the IPs resolved on connect.
 * Redirects are manual/forbidden by the caller so they cannot escape validation.
 */
export async function outboundFetch(url: string | URL, init: OutboundInit, policy: NetworkPolicy): Promise<Response> {
  const checked = assertOutboundUrl(String(url), policy);
  try {
    return (await undiciFetch(checked, { ...init, dispatcher: agentFor(policy) })) as unknown as Response;
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof OutboundBlocked) throw cause;
    throw err;
  }
}

export async function closeAgents(): Promise<void> {
  await Promise.all([...agents.values()].map((a) => a.close()));
  agents.clear();
}

/** Response body over the caller's byte limit (counted after decompression: gzip bombs included). */
export class BodyTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`response body exceeds ${limit} bytes`);
    this.name = 'BodyTooLarge';
  }
}

/** Reads a response body up to `limit` bytes, streaming; throws `BodyTooLarge` beyond it. */
export async function readLimited(res: Response, limit: number): Promise<{ text: string; bytes: number }> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > limit) {
    await res.body?.cancel();
    throw new BodyTooLarge(limit);
  }
  if (!res.body) return { text: '', bytes: 0 };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new BodyTooLarge(limit);
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes };
}

/** Largest OAuth token endpoint response read (a token response is a few hundred bytes). */
export const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
