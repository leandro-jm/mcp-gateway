import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const FORM_BODY_LIMIT = 64 * 1024;

/**
 * `application/x-www-form-urlencoded` bodies (OAuth endpoints and the login/consent forms), only
 * in the OAuth scope. A repeated key becomes an array, which the `oauth` package rejects
 * (RFC 6749 §3.1: parameters must not be included more than once).
 */
export function registerFormParser(app: FastifyInstance): void {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: FORM_BODY_LIMIT }, (_req, body, done) => {
    const out: Record<string, string | string[]> = {};
    for (const [key, value] of new URLSearchParams(body as string)) {
      const prev = out[key];
      out[key] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
    }
    done(null, out);
  });
}

/** A form field as a bounded string (`''` when absent, repeated or too long). */
export function field(body: unknown, name: string, max = 4096): string {
  const value = (body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' && value.length <= max ? value : '';
}

export const BROWSER_COOKIE = 'mgw_oauth';

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Binds the authorization in progress to this browser; only sent back to the authorize routes. */
export function setBrowserCookie(reply: FastifyReply, value: string, opts: { path: string; secure: boolean; maxAgeSeconds: number }): void {
  const attrs = [`${BROWSER_COOKIE}=${value}`, `Path=${opts.path}`, `Max-Age=${opts.maxAgeSeconds}`, 'HttpOnly', 'SameSite=Lax'];
  if (opts.secure) attrs.push('Secure');
  reply.header('set-cookie', attrs.join('; '));
}
