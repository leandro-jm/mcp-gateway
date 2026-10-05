/**
 * Reduced JSONPath for projection, evaluated segment by segment (lets us know whether a
 * path is a prefix of some selector, which `include` needs).
 *
 * Supported: `$`, `.key`, `['key']`, `[n]`, `[*]`, `.*`, `..key` (descendant).
 */
export type Seg = string | number;

type Token =
  | { t: 'key'; name: string }
  | { t: 'index'; n: number }
  | { t: 'anyIndex' }
  | { t: 'anyKey' }
  | { t: 'descend' };

/** Invalid selector. Never shown to users as-is: callers validate with `isValidSelector`. */
export class SelectorError extends Error {}

export function parseSelector(selector: string): Token[] {
  if (!selector.startsWith('$')) throw new SelectorError(`selector must start with $: ${selector}`);
  const out: Token[] = [];
  let i = 1;
  while (i < selector.length) {
    const rest = selector.slice(i);
    let m: RegExpExecArray | null;
    if (rest.startsWith('..')) {
      out.push({ t: 'descend' });
      i += 1;
      continue;
    }
    if (rest.startsWith('[*]')) {
      out.push({ t: 'anyIndex' });
      i += 3;
    } else if (rest.startsWith('.*')) {
      out.push({ t: 'anyKey' });
      i += 2;
    } else if ((m = /^\.([A-Za-z_$][\w$-]*)/.exec(rest))) {
      out.push({ t: 'key', name: m[1]! });
      i += m[0].length;
    } else if ((m = /^\[(\d+)\]/.exec(rest))) {
      out.push({ t: 'index', n: Number(m[1]) });
      i += m[0].length;
    } else if ((m = /^\['([^']+)'\]/.exec(rest))) {
      out.push({ t: 'key', name: m[1]! });
      i += m[0].length;
    } else {
      throw new SelectorError(`invalid selector: ${selector}`);
    }
  }
  return out;
}

function tokenMatches(tok: Token, seg: Seg): boolean {
  switch (tok.t) {
    case 'key':
      return typeof seg === 'string' && seg === tok.name;
    case 'index':
      return seg === tok.n;
    case 'anyIndex':
      return typeof seg === 'number';
    case 'anyKey':
      return typeof seg === 'string';
    case 'descend':
      return false;
  }
}

/**
 * Result of matching a concrete path against a selector:
 * - `full`: the path is selected (or is inside something selected);
 * - `prefix`: the path is an ancestor of something that may be selected;
 * - `none`.
 */
export type MatchState = 'full' | 'prefix' | 'none';

export function matchPath(tokens: Token[], path: Seg[]): MatchState {
  // Set of possible positions in the selector (NFA), treating `..` as "zero or more segments".
  let states = new Set<number>([0]);
  const closure = (s: Set<number>) => {
    const out = new Set(s);
    for (const p of s) if (tokens[p]?.t === 'descend') out.add(p + 1);
    return out;
  };
  states = closure(states);
  for (const seg of path) {
    if ([...states].some((p) => p >= tokens.length)) return 'full';
    const next = new Set<number>();
    for (const p of states) {
      const tok = tokens[p];
      if (!tok) continue;
      if (tok.t === 'descend') {
        next.add(p); // keep descending
        const after = tokens[p + 1];
        if (after && tokenMatches(after, seg)) next.add(p + 2);
      } else if (tokenMatches(tok, seg)) {
        next.add(p + 1);
      }
    }
    if (!next.size) return 'none';
    states = closure(next);
  }
  return [...states].some((p) => p >= tokens.length) ? 'full' : 'prefix';
}

export function isValidSelector(selector: string): boolean {
  try {
    parseSelector(selector);
    return true;
  } catch {
    return false;
  }
}

/**
 * Values selected by a reduced JSONPath. With a wildcard (`[*]`, `.*`, `..`) it returns
 * the list of values; without one, the single value (or `undefined`).
 */
export function selectValues(root: unknown, selector: string): unknown {
  const tokens = parseSelector(selector);
  const multi = tokens.some((t) => t.t === 'anyIndex' || t.t === 'anyKey' || t.t === 'descend');
  const out: unknown[] = [];
  const walk = (value: unknown, path: Seg[]) => {
    const state = matchPath(tokens, path);
    if (state === 'none') return;
    // exact `full`: the path has the same effective length as the selector
    if (state === 'full' && isExactMatch(tokens, path)) {
      out.push(value);
      if (!tokens.some((t) => t.t === 'descend')) return;
    }
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...path, i]));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
  };
  walk(root, []);
  return multi ? out : out[0];
}

/** `full` in matchPath also holds for descendants; here the path is the first to match (the parent does not). */
function isExactMatch(tokens: ReturnType<typeof parseSelector>, path: Seg[]): boolean {
  return path.length === 0 || matchPath(tokens, path.slice(0, -1)) !== 'full';
}
