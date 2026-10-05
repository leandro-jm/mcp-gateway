import { msg, type ServerMessage } from '@mcp-gateway/i18n/server';
import { RESERVED_HEADERS, snake } from '@mcp-gateway/openapi-toolgen';
import type { NameValue, SuggestedCredential } from './types';

/** Header and query names that carry credentials. Their values are dropped (ADR-014). */
const CREDENTIAL_HEADER = /(api[-_]?key|token|secret|session|signature|password)/i;
const CREDENTIAL_QUERY = /^(api[-_]?key|key|access[-_]?token|token|auth|auth[-_]?token|sig|signature|secret|client[-_]?secret|password)$/i;

/** Headers set by clients, browsers or the gateway itself: not API parameters. */
const STANDARD_HEADERS =
  /^(accept|accept-encoding|accept-language|accept-charset|content-type|user-agent|origin|referer|cache-control|pragma|dnt|priority|keep-alive|expect|if-none-match|if-modified-since|if-match|if-unmodified-since|upgrade-insecure-requests|x-requested-with|sec-.*|:.*)$/i;

export type SecurityScheme = Record<string, unknown>;

/** Strips credentials from captured requests and records the matching OpenAPI security schemes. */
export class AuthCollector {
  readonly schemes: Record<string, SecurityScheme> = {};
  suggestion: SuggestedCredential | undefined;
  private readonly warned = new Set<string>();

  constructor(private readonly warnings: ServerMessage[]) {}

  private record(location: string, name: string, scheme?: [string, SecurityScheme], suggestion?: SuggestedCredential) {
    const id = `${location}:${name.toLowerCase()}`;
    if (!this.warned.has(id)) {
      this.warned.add(id);
      this.warnings.push(msg('import.authStripped', { location, name }));
    }
    if (scheme) this.schemes[scheme[0]] ??= scheme[1];
    if (suggestion && !this.suggestion) this.suggestion = suggestion;
  }

  bearer(location: string, name: string) {
    this.record(location, name, ['bearerAuth', { type: 'http', scheme: 'bearer' }], { type: 'bearer_static' });
  }

  basic(location: string, name: string) {
    this.record(location, name, ['basicAuth', { type: 'http', scheme: 'basic' }], { type: 'basic' });
  }

  apiKey(where: 'header' | 'query', name: string, location: string = where) {
    this.record(location, name, [`apiKey_${snake(name) || 'key'}`, { type: 'apiKey', in: where, name }], { type: 'api_key', in: where, name });
  }

  oauth2(location: string, name: string) {
    this.record(location, name, ['oauth2', { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://example.invalid/token', scopes: {} } } }], {
      type: 'oauth2_client_credentials',
    });
  }

  /** Credential the importer cannot express (cookies, digest, AWS signatures...): only warns. */
  dropped(location: string, name: string) {
    this.record(location, name);
  }

  /** Keeps only the headers that are API parameters; credentials are recorded and removed. */
  headers(headers: NameValue[]): NameValue[] {
    const kept: NameValue[] = [];
    for (const h of headers) {
      const name = h.name.trim();
      const lower = name.toLowerCase();
      if (lower === 'authorization') {
        if (/^bearer\s/i.test(h.value)) this.bearer('header', name);
        else if (/^basic\s/i.test(h.value)) this.basic('header', name);
        else this.apiKey('header', name);
      } else if (lower === 'cookie' || lower === 'proxy-authorization') {
        this.dropped('header', name);
      } else if (CREDENTIAL_HEADER.test(lower)) {
        this.apiKey('header', name);
      } else if (!RESERVED_HEADERS.test(lower) && !STANDARD_HEADERS.test(lower) && name) {
        kept.push({ name, value: h.value });
      }
    }
    return kept;
  }

  /** Removes credential query parameters. */
  query(query: NameValue[]): NameValue[] {
    return query.filter((q) => {
      if (!CREDENTIAL_QUERY.test(q.name)) return true;
      this.apiKey('query', q.name);
      return false;
    });
  }

  securityRequirement(): Array<Record<string, string[]>> {
    return Object.keys(this.schemes).map((k) => ({ [k]: [] }));
  }
}
