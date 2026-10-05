import { snake } from '@mcp-gateway/openapi-toolgen';

/** Segments that look like identifiers (ADR-014 §7). Version segments (`v1`, `v2.1`) never match. */
const ID_PATTERNS = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{16,}$/i,
  /^[0-9A-HJKMNP-TV-Z]{26}$/,
  /^[a-z]{1,8}[-_]\d{2,}$/i,
  /^(?=.*\d)(?=.*[a-z])[A-Za-z0-9_-]{20,}$/i,
];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = /^v\d+(\.\d+)*$/i;
/** Explicit placeholders: `{id}`, `{{id}}`, `:id`, `<id>`. */
const PLACEHOLDER = /^(?:\{\{\s*([^{}\s]+)\s*\}\}|\{([^{}]+)\}|:([A-Za-z_][\w-]*)|<([A-Za-z_][\w-]*)>)$/;

export function isIdSegment(segment: string): boolean {
  return !VERSION.test(segment) && ID_PATTERNS.some((re) => re.test(segment));
}

/** Naive singular for resource names (English and Portuguese plurals). */
export function singular(word: string): string {
  const w = word.toLowerCase();
  if (/coes$/.test(w)) return w.replace(/coes$/, 'cao');
  if (/ies$/.test(w)) return w.replace(/ies$/, 'y');
  if (/(ss|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  // Portuguese -or plurals (colaboradores, setores, valores); English `stores` keeps the regular rule
  if (/[aeiou][dtsl]ores$/.test(w)) return w.slice(0, -2);
  if (/[^s]s$/.test(w)) return w.slice(0, -1);
  return w;
}

export interface TemplatedPath {
  path: string;
  params: Array<{ name: string; sample?: string }>;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Turns a concrete path into an OpenAPI template: explicit placeholders are kept and identifier-like
 * segments become `{<resource>_id}` (`/colaboradores/col-00001` → `/colaboradores/{colaborador_id}`).
 */
export function templatePath(rawPath: string): TemplatedPath {
  const segments = (rawPath.startsWith('/') ? rawPath : `/${rawPath}`).split('/').slice(1);
  const params: TemplatedPath['params'] = [];
  const used = new Set<string>();
  const unique = (base: string) => {
    let name = base || 'id';
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    return name;
  };
  let previous = '';
  const out = segments.map((raw) => {
    const segment = decode(raw);
    const placeholder = PLACEHOLDER.exec(segment);
    if (placeholder) {
      const name = unique(snake(placeholder.slice(1).find(Boolean)!) || 'id');
      params.push({ name });
      previous = '';
      return `{${name}}`;
    }
    if (isIdSegment(segment) || DATE.test(segment)) {
      const kind = DATE.test(segment) ? 'date' : 'id';
      const name = unique(previous ? `${snake(singular(previous))}_${kind}` : kind);
      params.push({ name, sample: segment });
      previous = '';
      return `{${name}}`;
    }
    previous = segment;
    return segment.replace(/[{}]/g, '');
  });
  return { path: `/${out.join('/')}`, params };
}
