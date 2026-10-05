import { msg, type ServerMessage } from '@mcp-gateway/i18n/server';
import { snake } from '@mcp-gateway/openapi-toolgen';
import { AuthCollector } from './auth';
import { suggestName } from './naming';
import { buildOpenApi } from './openapi-builder';
import { importError, MAX_HAR_ENTRIES, type CapturedBody, type CapturedRequest, type CapturedResponse, type ImportResult, type NameValue } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Postman descriptions are a string or `{ content, type }`. */
function text(v: unknown): string | undefined {
  const s = isObj(v) ? str(v.content) : str(v);
  return s?.trim() || undefined;
}

/** `{ collection: {...} }` (Postman API response) → the collection itself. */
export function unwrapCollection(doc: unknown): unknown {
  return isObj(doc) && isObj(doc.collection) && isObj(doc.collection.info) ? doc.collection : doc;
}

export function isPostmanV1(doc: unknown): boolean {
  return isObj(doc) && Array.isArray(doc.requests) && !isObj(doc.info);
}

export function isPostmanCollection(doc: unknown): boolean {
  if (isPostmanV1(doc)) return true;
  if (!isObj(doc) || !isObj(doc.info) || !Array.isArray(doc.item)) return false;
  return typeof doc.info._postman_id === 'string' || /getpostman\.com/.test(String(doc.info.schema ?? ''));
}

/** Key/value lists of Postman (`[{key, value, disabled}]`), skipping disabled entries. */
function pairs(list: unknown): NameValue[] {
  return arr(list)
    .filter(isObj)
    .filter((p) => p.disabled !== true && str(p.key ?? p.name))
    .map((p) => ({ name: str(p.key ?? p.name)!, value: str(p.value) ?? '' }));
}

/** Auth params come as `[{key, value}]` (v2.1) or `{key: value}` (v2.0). */
function authParams(auth: Obj, type: string): Record<string, string> {
  const raw = auth[type];
  if (Array.isArray(raw)) return Object.fromEntries(pairs(raw).map((p) => [p.name, p.value]));
  if (isObj(raw)) return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, str(v) ?? '']));
  return {};
}

function applyAuth(auth: Obj | undefined, collector: AuthCollector) {
  if (!auth) return;
  const type = str(auth.type) ?? 'noauth';
  switch (type) {
    case 'noauth':
    case 'inherit':
      return;
    case 'bearer':
      return collector.bearer('auth', 'bearer');
    case 'basic':
      return collector.basic('auth', 'basic');
    case 'apikey': {
      const p = authParams(auth, 'apikey');
      return collector.apiKey(p.in === 'query' ? 'query' : 'header', p.key || 'x-api-key', 'auth');
    }
    case 'oauth2':
      return collector.oauth2('auth', 'oauth2');
    default:
      return collector.dropped('auth', type);
  }
}

interface UrlParts {
  origin: string | null;
  path: string;
  rawQuery: string;
  unresolved?: string;
}

/** Splits a Postman URL, resolving `{{vars}}` only in the base (scheme/host); path variables stay templates. */
function splitUrl(raw: string, vars: Map<string, string>): UrlParts {
  let s = raw.trim();
  for (let n = 0; n < 5; n++) {
    const m = /^\{\{\s*([^{}\s]+)\s*\}\}/.exec(s);
    const value = m ? vars.get(m[1]!) : undefined;
    if (!m || !value) break;
    s = value.replace(/\/+$/, '') + s.slice(m[0].length);
  }
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/?#]*)([^?#]*)(?:\?([^#]*))?/i.exec(s)!;
  const scheme = (m[1] ?? 'http').toLowerCase();
  const authority = (m[2] ?? '').replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (all, k: string) => vars.get(k) ?? all);
  const path = m[3] || '/';
  const rawQuery = m[4] ?? '';
  const unresolved = /\{\{\s*([^{}\s]+)\s*\}\}/.exec(authority)?.[1];
  if (!authority || unresolved || !/^https?$/.test(scheme)) return { origin: null, path, rawQuery, ...(unresolved ? { unresolved } : {}) };
  const host = authority.replace(/^[^@]*@/, '').toLowerCase();
  return { origin: `${scheme}://${host}`, path, rawQuery };
}

function rawUrl(url: unknown): string {
  if (typeof url === 'string') return url;
  if (!isObj(url)) return '';
  if (typeof url.raw === 'string') return url.raw;
  const protocol = str(url.protocol);
  const host = Array.isArray(url.host) ? url.host.join('.') : (str(url.host) ?? '');
  const port = str(url.port);
  const path = Array.isArray(url.path) ? url.path.map((p) => (isObj(p) ? str(p.value) ?? '' : String(p))).join('/') : (str(url.path) ?? '');
  return `${protocol ? `${protocol}://` : ''}${host}${port ? `:${port}` : ''}/${path.replace(/^\//, '')}`;
}

function contentTypeOf(headers: NameValue[]): string | undefined {
  return headers.findLast((h) => h.name.toLowerCase() === 'content-type')?.value;
}

/** Raw bodies may hold unquoted `{{vars}}` (`"n": {{n}}`): they become `null` for schema inference only. */
function parseJsonWithVars(textBody: string): unknown {
  return JSON.parse(textBody.replace(/(?<!")\{\{\s*[^{}\s]+\s*\}\}(?!")/g, 'null'));
}

type SkipReason = 'graphql' | 'file';

function parseBody(body: unknown, headers: NameValue[], label: string, warnings: ServerMessage[]): CapturedBody | SkipReason | undefined {
  if (!isObj(body) || body.disabled === true) return undefined;
  const declared = contentTypeOf(headers);
  switch (str(body.mode)) {
    case 'raw': {
      const rawText = str(body.raw) ?? '';
      if (!rawText.trim()) return undefined;
      const options = isObj(body.options) && isObj(body.options.raw) ? body.options.raw : {};
      const json = options.language === 'json' || (declared ? /[/+]json\b/i.test(declared) : /^\s*[[{]/.test(rawText));
      if (!json) return { contentType: declared ?? 'text/plain', kind: 'text' };
      try {
        return { contentType: declared ?? 'application/json', kind: 'json', json: parseJsonWithVars(rawText) };
      } catch {
        warnings.push(msg('import.bodyNotJson', { operation: label }));
        return { contentType: declared ?? 'text/plain', kind: 'text' };
      }
    }
    case 'urlencoded':
      return { contentType: 'application/x-www-form-urlencoded', kind: 'form', fields: pairs(body.urlencoded) };
    case 'formdata':
      return {
        contentType: 'multipart/form-data',
        kind: 'form',
        fields: arr(body.formdata)
          .filter(isObj)
          .filter((f) => f.disabled !== true && str(f.key))
          .map((f) => (f.type === 'file' ? { name: str(f.key)!, value: '', binary: true } : { name: str(f.key)!, value: str(f.value) ?? '' })),
      };
    case 'graphql':
      return 'graphql';
    case 'file':
      return 'file';
    default:
      return undefined;
  }
}

function parseResponses(list: unknown): CapturedResponse[] {
  return arr(list)
    .filter(isObj)
    .map((r) => {
      const headers = pairs(r.header);
      const status = Number(r.code ?? 200) || 200;
      const contentType = contentTypeOf(headers) ?? (r._postman_previewlanguage === 'json' ? 'application/json' : undefined);
      const body = str(r.body);
      let json: unknown;
      if (body && contentType && /[/+]json\b/i.test(contentType)) {
        try {
          json = JSON.parse(body);
        } catch {
          json = undefined;
        }
      }
      return { status, ...(contentType ? { contentType } : {}), ...(json !== undefined ? { json } : {}) };
    });
}

function hasScripts(node: Obj): boolean {
  return arr(node.event).some((e) => isObj(e) && isObj(e.script) && arr(e.script.exec).some((l) => typeof l === 'string' && l.trim()));
}

/** Converts a Postman collection (v2.0/v2.1) into OpenAPI 3.1. */
export function importPostman(input: unknown): ImportResult {
  const doc = unwrapCollection(input);
  if (isPostmanV1(doc)) throw importError('import.postmanV1Unsupported');
  if (!isObj(doc) || !isObj(doc.info)) throw importError('import.unknownFormat');
  const warnings: ServerMessage[] = [];
  const auth = new AuthCollector(warnings);
  const vars = new Map(pairs(doc.variable).filter((p) => p.value).map((p) => [p.name, p.value]));
  const requests: CapturedRequest[] = [];
  const unresolved = new Set<string>();
  let scripts = hasScripts(doc);

  const walk = (items: unknown[], folder: string | undefined, inheritedAuth: Obj | undefined) => {
    for (const item of items.filter(isObj)) {
      if (requests.length >= MAX_HAR_ENTRIES) throw importError('import.tooManyEntries', { max: MAX_HAR_ENTRIES });
      scripts ||= hasScripts(item);
      const itemAuth = isObj(item.auth) && item.auth.type !== 'inherit' ? item.auth : inheritedAuth;
      if (Array.isArray(item.item)) {
        walk(item.item, str(item.name) ?? folder, itemAuth);
        continue;
      }
      if (item.request === undefined) continue;
      const request: Obj = isObj(item.request) ? item.request : { url: item.request };
      const name = str(item.name) ?? rawUrl(request.url);
      const method = (str(request.method) ?? 'GET').toUpperCase();
      const parts = splitUrl(rawUrl(request.url), vars);
      if (parts.unresolved && !unresolved.has(parts.unresolved)) {
        unresolved.add(parts.unresolved);
        warnings.push(msg('import.unresolvedVariable', { name: parts.unresolved }));
      }
      const headers = pairs(request.header);
      const body = parseBody(request.body, headers, name, warnings);
      if (body === 'graphql') {
        warnings.push(msg('import.graphqlSkipped', { name }));
        continue;
      }
      if (body === 'file') {
        warnings.push(msg('import.fileBodySkipped', { name }));
        continue;
      }
      applyAuth(isObj(request.auth) && request.auth.type !== 'inherit' ? request.auth : itemAuth, auth);
      const urlObj = isObj(request.url) ? request.url : {};
      const query = Array.isArray(urlObj.query)
        ? pairs(urlObj.query)
        : [...new URLSearchParams(parts.rawQuery)].map(([n, v]) => ({ name: n, value: v }));
      const pathParamDescriptions = Object.fromEntries(
        arr(urlObj.variable)
          .filter(isObj)
          .flatMap((v) => (str(v.key) && text(v.description) ? [[snake(str(v.key)!), text(v.description)!]] : [])),
      );
      const description = text(request.description);
      requests.push({
        label: name,
        method,
        origin: parts.origin,
        path: parts.path,
        ...(Object.keys(pathParamDescriptions).length ? { pathParamDescriptions } : {}),
        query: query.map((q) => ({ name: q.name, value: /\{\{.*\}\}/.test(q.value) ? '' : q.value })),
        headers,
        ...(body ? { body } : {}),
        responses: parseResponses(item.response),
        summary: name,
        ...(description ? { description } : {}),
        ...(folder ? { tag: folder } : {}),
      });
    }
  };
  walk(arr(doc.item), undefined, isObj(doc.auth) ? doc.auth : undefined);
  if (scripts) warnings.push(msg('import.postmanScriptsIgnored'));

  const title = str(doc.info.name) ?? 'Postman collection';
  const description = text(doc.info.description);
  const { openapi, baseUrlCandidates } = buildOpenApi(requests, { title, ...(description ? { description } : {}), auth, warnings });
  return {
    format: 'postman',
    openapi,
    baseUrlCandidates,
    suggestedName: suggestName(title),
    ...(auth.suggestion ? { suggestedCredential: auth.suggestion } : {}),
    warnings,
  };
}
