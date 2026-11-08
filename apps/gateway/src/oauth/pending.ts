import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Locale } from '@mcp-gateway/i18n';
import type { AuthorizationRequest } from '@mcp-gateway/oauth';
import type { Redis } from 'ioredis';

/** Lifetime of an authorization in progress (ADR-030). */
export const PENDING_TTL_SECONDS = 600;

export interface PendingClient {
  rowId: string;
  clientId: string;
  kind: 'cimd' | 'dcr';
  name: string;
}

export interface PendingUser {
  id: string;
  username: string;
  tenantId: string;
  tenantSlug: string;
  locale: Locale;
}

/**
 * An authorization request between `GET /oauth/authorize` and the consent decision. It lives in
 * Redis only; the browser holds its id, a CSRF token in the forms and a cookie whose hash is
 * stored here, so another browser cannot continue it.
 */
export interface PendingAuthorization {
  id: string;
  csrf: string;
  browserHash: string;
  request: AuthorizationRequest;
  client: PendingClient;
  /** Set once the user signed in. */
  user?: PendingUser;
}

const key = (id: string) => `oauth:req:${id}`;
const random = () => randomBytes(32).toString('base64url');
export const hashBrowser = (value: string) => createHash('sha256').update(value).digest('hex');

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class PendingAuthorizations {
  constructor(private readonly redis: Redis) {}

  /** Starts an authorization; returns it with the cookie value to give the browser. */
  async create(request: AuthorizationRequest, client: PendingClient): Promise<{ pending: PendingAuthorization; browser: string }> {
    const browser = random();
    const pending: PendingAuthorization = { id: random(), csrf: random(), browserHash: hashBrowser(browser), request, client };
    await this.redis.set(key(pending.id), JSON.stringify(pending), 'EX', PENDING_TTL_SECONDS);
    return { pending, browser };
  }

  /** The pending request, only if the form's CSRF token and the browser cookie both match. */
  async get(id: string, csrf: string, browser: string | undefined): Promise<PendingAuthorization | undefined> {
    if (!id || id.length > 64) return undefined;
    const raw = await this.redis.get(key(id));
    if (!raw) return undefined;
    const pending = JSON.parse(raw) as PendingAuthorization;
    if (!browser || !sameSecret(pending.csrf, csrf) || !sameSecret(pending.browserHash, hashBrowser(browser))) return undefined;
    return pending;
  }

  async save(pending: PendingAuthorization): Promise<void> {
    await this.redis.set(key(pending.id), JSON.stringify(pending), 'KEEPTTL');
  }

  /** Removes the request; `true` only for the first caller (a double submit cannot issue two codes). */
  async consume(id: string): Promise<boolean> {
    return (await this.redis.del(key(id))) === 1;
  }
}
