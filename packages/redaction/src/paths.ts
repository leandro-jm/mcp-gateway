/**
 * Field selectors: a plain name (matches the key at any level) or a reduced JSONPath:
 * `$` root, `.key`, `['key']`, `[*]` any index, `.*` any key, `..key` recursive.
 * Concrete paths are represented as `$.items[0].cpf`.
 */
export type PathSeg = string | number;

export function formatPath(segs: PathSeg[]): string {
  return `$${segs.map((s) => (typeof s === 'number' ? `[${s}]` : /^[A-Za-z_$][\w$]*$/.test(s) ? `.${s}` : `['${s.replace(/'/g, "\\'")}']`)).join('')}`;
}

const cache = new Map<string, RegExp>();

function selectorToRegExp(selector: string): RegExp {
  let re = '^\\$';
  let i = 1;
  while (i < selector.length) {
    if (selector.startsWith('..', i)) {
      re += '(?:\\.[^.\\[]+|\\[[^\\]]+\\])*';
      i += 1; // the next `.` is handled below
      continue;
    }
    if (selector.startsWith('[*]', i)) {
      re += '\\[\\d+\\]';
      i += 3;
      continue;
    }
    if (selector.startsWith('.*', i)) {
      re += '(?:\\.[^.\\[]+|\\[\'[^\\]]+\'\\])';
      i += 2;
      continue;
    }
    if (selector[i] === '.') {
      const m = /^\.([A-Za-z_$][\w$-]*)/.exec(selector.slice(i));
      if (!m) throw new Error(`invalid selector: ${selector}`);
      re += `\\.${m[1]!.replace(/[$]/g, '\\$')}`;
      i += m[0].length;
      continue;
    }
    const br = /^\[(?:'([^']+)'|(\d+))\]/.exec(selector.slice(i));
    if (br) {
      re += br[1] !== undefined ? `(?:\\.${br[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|\\['${br[1]}'\\])` : `\\[${br[2]}\\]`;
      i += br[0].length;
      continue;
    }
    throw new Error(`invalid selector: ${selector}`);
  }
  return new RegExp(`${re}$`);
}

export function matchesSelector(selector: string, segs: PathSeg[]): boolean {
  if (!selector.startsWith('$')) {
    const last = [...segs].reverse().find((s) => typeof s === 'string');
    return typeof last === 'string' && last.toLowerCase() === selector.toLowerCase() && typeof segs[segs.length - 1] === 'string';
  }
  let re = cache.get(selector);
  if (!re) {
    re = selectorToRegExp(selector);
    cache.set(selector, re);
  }
  return re.test(formatPath(segs));
}

export function isValidSelector(selector: string): boolean {
  if (!selector.startsWith('$')) return /^[\w-]+$/.test(selector);
  try {
    selectorToRegExp(selector);
    return true;
  } catch {
    return false;
  }
}
