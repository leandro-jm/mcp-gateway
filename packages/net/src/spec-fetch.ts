import type { CredentialConfig, CredentialType, NetworkPolicy } from '@mcp-gateway/core';
import { BodyTooLarge, MAX_TOKEN_RESPONSE_BYTES, OutboundBlocked, outboundFetch, readLimited } from './outbound';
import { msg, translate, type ServerMessage } from '@mcp-gateway/i18n/server';
import { parse as parseYaml } from 'yaml';

export interface FetchSpecOptions {
  timeoutMs: number;
  maxBytes: number;
  network: NetworkPolicy;
  credential?: { type: CredentialType; config: CredentialConfig };
}

/** Spec download failure. `message` is English (logs); `msg` is persisted on the crawl run (ADR-012). */
export class SpecFetchError extends Error {
  constructor(readonly msg: ServerMessage) {
    super(translate(msg));
    this.name = 'SpecFetchError';
  }
}

async function oauthToken(config: Record<string, unknown>, grant: 'client_credentials' | 'password', timeoutMs: number, network: NetworkPolicy) {
  const body = new URLSearchParams({ grant_type: grant });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (config.authMethod === 'basic') {
    headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret ?? ''}`).toString('base64')}`;
  } else {
    body.set('client_id', String(config.clientId));
    if (config.clientSecret) body.set('client_secret', String(config.clientSecret));
  }
  if (grant === 'password') {
    body.set('username', String(config.username));
    body.set('password', String(config.password));
  }
  if (config.scope) body.set('scope', String(config.scope));
  if (config.audience) body.set('audience', String(config.audience));
  const res = await outboundFetch(String(config.tokenUrl), { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }, network);
  if (!res.ok) throw new SpecFetchError(msg('crawler.tokenFailed', { status: res.status }));
  let json: { access_token?: string };
  try {
    json = JSON.parse((await readLimited(res, MAX_TOKEN_RESPONSE_BYTES)).text) as typeof json;
  } catch {
    throw new SpecFetchError(msg('crawler.tokenMissing'));
  }
  if (!json.access_token) throw new SpecFetchError(msg('crawler.tokenMissing'));
  return json.access_token;
}

/** Applies the source credential to the spec download request. */
async function authorize(url: URL, headers: Record<string, string>, opts: FetchSpecOptions): Promise<void> {
  const c = opts.credential;
  if (!c) return;
  const cfg = c.config as Record<string, unknown>;
  switch (c.type) {
    case 'bearer_static':
      headers.authorization = `Bearer ${cfg.token}`;
      return;
    case 'basic':
      headers.authorization = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;
      return;
    case 'api_key':
      if (cfg.in === 'query') url.searchParams.set(String(cfg.name), String(cfg.value));
      else headers[String(cfg.name).toLowerCase()] = String(cfg.value);
      return;
    case 'oauth2_client_credentials':
      headers.authorization = `Bearer ${await oauthToken(cfg, 'client_credentials', opts.timeoutMs, opts.network)}`;
      return;
    case 'oauth2_password':
      headers.authorization = `Bearer ${await oauthToken(cfg, 'password', opts.timeoutMs, opts.network)}`;
      return;
  }
}

/** Downloads the spec (JSON or YAML), with a size limit and a timeout. */
export async function fetchSpec(specUrl: string, opts: FetchSpecOptions): Promise<unknown> {
  const url = new URL(specUrl);
  const headers: Record<string, string> = { accept: 'application/json, application/yaml;q=0.9, */*;q=0.5' };
  await authorize(url, headers, opts);
  let res: Response;
  try {
    res = await outboundFetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs) }, opts.network);
  } catch (err) {
    if (err instanceof OutboundBlocked) throw new SpecFetchError(msg('crawler.specUrlBlocked', { error: err.msg }));
    throw new SpecFetchError(msg('crawler.specDownloadFailed', { error: (err as Error).message }));
  }
  if (!res.ok) throw new SpecFetchError(msg('crawler.specHttpError', { status: res.status }));
  if (!res.body) throw new SpecFetchError(msg('crawler.specEmptyBody'));
  let text: string;
  try {
    ({ text } = await readLimited(res, opts.maxBytes));
  } catch (err) {
    if (err instanceof BodyTooLarge) throw new SpecFetchError(msg('crawler.specTooLarge', { max: opts.maxBytes }));
    throw new SpecFetchError(msg('crawler.specDownloadFailed', { error: (err as Error).message }));
  }
  try {
    return text.trimStart().startsWith('{') ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 100 });
  } catch (err) {
    throw new SpecFetchError(msg('crawler.specInvalidFormat', { error: (err as Error).message }));
  }
}
