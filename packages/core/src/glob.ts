/** Simple glob over tool names: `*` (any sequence) and `?` (one character). */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

const cache = new Map<string, RegExp>();

export function globMatch(pattern: string, value: string): boolean {
  let re = cache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    if (cache.size > 5000) cache.clear();
    cache.set(pattern, re);
  }
  return re.test(value);
}

/** Specificity of a pattern: the more literal characters, the more specific. */
export function globSpecificity(pattern: string): number {
  return pattern.replace(/[*?]/g, '').length + (/[*?]/.test(pattern) ? 0 : 1000);
}
