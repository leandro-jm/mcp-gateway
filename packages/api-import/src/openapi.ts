import { detectVersion } from '@mcp-gateway/openapi-toolgen';
import { suggestName } from './naming';
import type { ImportResult, OpenApiDocument, SuggestedCredential } from './types';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function serverUrls(doc: OpenApiDocument): string[] {
  if (doc.swagger) {
    if (typeof doc.host !== 'string') return [];
    const scheme = Array.isArray(doc.schemes) && typeof doc.schemes[0] === 'string' ? doc.schemes[0] : 'https';
    return [`${scheme}://${doc.host}${typeof doc.basePath === 'string' ? doc.basePath : ''}`.replace(/\/+$/, '')];
  }
  if (!Array.isArray(doc.servers)) return [];
  return doc.servers.filter(isObj).flatMap((s) => {
    let url = String(s.url ?? '');
    if (isObj(s.variables)) {
      for (const [name, v] of Object.entries(s.variables)) if (isObj(v)) url = url.replaceAll(`{${name}}`, String(v.default ?? ''));
    }
    return /^https?:\/\//i.test(url) ? [url.replace(/\/+$/, '')] : [];
  });
}

function credentialFor(doc: OpenApiDocument): SuggestedCredential | undefined {
  const schemes = isObj(doc.components) && isObj(doc.components.securitySchemes) ? doc.components.securitySchemes : isObj(doc.securityDefinitions) ? doc.securityDefinitions : {};
  for (const s of Object.values(schemes)) {
    if (!isObj(s)) continue;
    if (s.type === 'basic' || (s.type === 'http' && String(s.scheme).toLowerCase() === 'basic')) return { type: 'basic' };
    if (s.type === 'http' && String(s.scheme).toLowerCase() === 'bearer') return { type: 'bearer_static' };
    if (s.type === 'apiKey' && (s.in === 'header' || s.in === 'query') && typeof s.name === 'string') return { type: 'api_key', in: s.in, name: s.name };
    if (s.type === 'oauth2') {
      const flows = isObj(s.flows) ? s.flows : {};
      if (flows.password || s.flow === 'password') return { type: 'oauth2_password' };
      return { type: 'oauth2_client_credentials' };
    }
  }
  return undefined;
}

/** OpenAPI pasted as text: kept as-is; base URL and credential type come from the spec. */
export function importOpenApi(doc: OpenApiDocument): ImportResult {
  detectVersion(doc);
  const info = isObj(doc.info) ? doc.info : {};
  const credential = credentialFor(doc);
  return {
    format: 'openapi',
    openapi: doc,
    baseUrlCandidates: [...new Set(serverUrls(doc))],
    ...(typeof info.title === 'string' && info.title.trim() ? { suggestedName: suggestName(info.title) } : {}),
    ...(credential ? { suggestedCredential: credential } : {}),
    warnings: [],
  };
}
