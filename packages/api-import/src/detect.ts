import { parse as parseYaml } from 'yaml';
import { importCurl } from './curl';
import { importHar, isHar } from './har';
import { importOpenApi } from './openapi';
import { importPostman, isPostmanCollection, unwrapCollection } from './postman';
import { importError, type ImportFormat, type ImportResult, type OpenApiDocument } from './types';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const CURL = /^\s*(\$\s+)?curl(\.exe)?\s/i;

/** Format of an already parsed document (JSON/YAML), or undefined when unrecognized. */
export function detectDocumentFormat(doc: unknown): Exclude<ImportFormat, 'curl'> | undefined {
  const d = unwrapCollection(doc);
  if (isPostmanCollection(d)) return 'postman';
  if (isHar(d)) return 'har';
  if (isObj(d) && (typeof d.openapi === 'string' || typeof d.swagger === 'string')) return 'openapi';
  return undefined;
}

/** Parses JSON, or YAML with alias expansion limited (ADR-003 T11, like the spec fetcher). */
export function parseStructured(text: string): unknown {
  const trimmed = text.trim();
  try {
    return /^[[{]/.test(trimmed) ? JSON.parse(trimmed) : parseYaml(trimmed, { maxAliasCount: 100 });
  } catch (err) {
    throw importError('import.invalidJson', { error: (err as Error).message.slice(0, 200) });
  }
}

export function detectFormat(text: string): ImportFormat {
  if (CURL.test(text)) return 'curl';
  const format = detectDocumentFormat(parseStructured(text));
  if (!format) throw importError('import.unknownFormat');
  return format;
}

/** Converts an already parsed document (e.g. downloaded from a URL) into OpenAPI. */
export function importDocument(doc: unknown, format: Exclude<ImportFormat, 'curl'> | 'auto' = 'auto'): ImportResult {
  const resolved = format === 'auto' ? detectDocumentFormat(doc) : format;
  switch (resolved) {
    case 'postman':
      return importPostman(doc);
    case 'har':
      return importHar(doc);
    case 'openapi':
      if (!isObj(doc)) throw importError('import.unknownFormat');
      return importOpenApi(doc as OpenApiDocument);
    default:
      throw importError('import.unknownFormat');
  }
}

/** Converts pasted text (cURL, Postman, HAR or OpenAPI JSON/YAML) into OpenAPI (ADR-014). */
export function parseImportText(text: string, format: ImportFormat | 'auto' = 'auto'): ImportResult {
  if (format === 'curl' || (format === 'auto' && CURL.test(text))) return importCurl(text);
  return importDocument(parseStructured(text), format);
}
