import type { ServerMessage } from '@mcp-gateway/i18n/server';
import { AuthCollector } from './auth';
import { suggestName } from './naming';
import { buildOpenApi } from './openapi-builder';
import { importError, MAX_HAR_ENTRIES, type CapturedBody, type CapturedRequest, type ImportResult, type NameValue } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function isHar(doc: unknown): boolean {
  return isObj(doc) && isObj(doc.log) && Array.isArray(doc.log.entries);
}

/** Browser resource types that are API calls (Chrome/Firefox `_resourceType`). */
const API_RESOURCE_TYPES = new Set(['xhr', 'fetch']);
const STATIC_MIME = /^(image|font|audio|video)\/|^text\/(css|html|javascript)|javascript|^application\/(wasm|manifest\+json|x-font)/i;
const STATIC_EXT = /\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|mp4|webm|mp3|wasm|html?)$/i;

function nameValues(list: unknown): NameValue[] {
  return arr(list)
    .filter(isObj)
    .filter((p) => str(p.name))
    .map((p) => ({ name: str(p.name)!, value: str(p.value) ?? '' }));
}

function decodeText(content: Obj): string | undefined {
  const t = str(content.text);
  if (t === undefined) return undefined;
  if (content.encoding !== 'base64') return t;
  try {
    return Buffer.from(t, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

function parseJson(t: string | undefined): unknown {
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function requestBody(postData: unknown): CapturedBody | undefined {
  if (!isObj(postData)) return undefined;
  const contentType = str(postData.mimeType) || 'application/octet-stream';
  const t = str(postData.text);
  if (/[/+]json\b/i.test(contentType)) {
    const json = parseJson(t);
    return json === undefined ? (t ? { contentType, kind: 'text' } : undefined) : { contentType, kind: 'json', json };
  }
  if (/x-www-form-urlencoded|multipart\/form-data/i.test(contentType)) {
    const params = nameValues(postData.params);
    const fields = params.length ? params : t ? [...new URLSearchParams(t)].map(([name, value]) => ({ name, value })) : [];
    const binary = new Set(arr(postData.params).filter((p) => isObj(p) && str(p.fileName)).map((p) => str((p as Obj).name)));
    return { contentType, kind: 'form', fields: fields.map((f) => (binary.has(f.name) ? { ...f, value: '', binary: true } : f)) };
  }
  return t ? { contentType, kind: 'text' } : undefined;
}

/** Whether a HAR entry is an API call worth importing (not a page, asset or CORS preflight). */
function isApiEntry(entry: Obj, url: URL, method: string): boolean {
  if (!/^https?:$/.test(url.protocol) || method === 'OPTIONS') return false;
  const response = isObj(entry.response) ? entry.response : {};
  if (!Number(response.status)) return false;
  const resourceType = str(entry._resourceType);
  if (resourceType) return API_RESOURCE_TYPES.has(resourceType.toLowerCase());
  const mime = isObj(response.content) ? (str(response.content.mimeType) ?? '') : '';
  return !STATIC_EXT.test(url.pathname) && !STATIC_MIME.test(mime);
}

/** Converts a HAR 1.2 recording into OpenAPI 3.1 (only API calls of the most frequent origin). */
export function importHar(doc: unknown): ImportResult {
  if (!isHar(doc)) throw importError('import.unknownFormat');
  const entries = arr((doc as { log: Obj }).log.entries).filter(isObj);
  if (entries.length > MAX_HAR_ENTRIES) throw importError('import.tooManyEntries', { max: MAX_HAR_ENTRIES });
  const warnings: ServerMessage[] = [];
  const auth = new AuthCollector(warnings);
  const requests: CapturedRequest[] = [];
  for (const entry of entries) {
    const req = isObj(entry.request) ? entry.request : {};
    const method = (str(req.method) ?? 'GET').toUpperCase();
    let url: URL;
    try {
      url = new URL(str(req.url) ?? '');
    } catch {
      continue;
    }
    if (!isApiEntry(entry, url, method)) continue;
    const response = isObj(entry.response) ? entry.response : {};
    const content = isObj(response.content) ? response.content : {};
    const contentType = str(content.mimeType) || undefined;
    const json = contentType && /[/+]json\b/i.test(contentType) ? parseJson(decodeText(content)) : undefined;
    const body = requestBody(req.postData);
    const query = Array.isArray(req.queryString) ? nameValues(req.queryString) : [...url.searchParams].map(([name, value]) => ({ name, value }));
    requests.push({
      label: `${method} ${url.origin}${url.pathname}`,
      method,
      origin: url.origin,
      path: url.pathname,
      query,
      headers: nameValues(req.headers),
      ...(body ? { body } : {}),
      responses: [{ status: Number(response.status), ...(contentType ? { contentType } : {}), ...(json !== undefined ? { json } : {}) }],
    });
  }
  if (!requests.length) throw importError('import.harEmpty');
  const { openapi, baseUrlCandidates } = buildOpenApi(requests, { title: 'HAR import', auth, warnings });
  const host = baseUrlCandidates[0] ? new URL(baseUrlCandidates[0]).host : undefined;
  if (host) (openapi.info as Obj).title = host;
  return {
    format: 'har',
    openapi,
    baseUrlCandidates,
    ...(host ? { suggestedName: suggestName(new URL(baseUrlCandidates[0]!).hostname) } : {}),
    ...(auth.suggestion ? { suggestedCredential: auth.suggestion } : {}),
    warnings,
  };
}
