/** Longest pattern accepted for user-configurable regular expressions. */
export const MAX_PATTERN_LENGTH = 200;

const QUANT = String.raw`(?:[+*]|\{\d+,\d*\})`;
const GROUP_BODY = String.raw`(?:[^()\\]|\\.)*`;
/** A quantified group whose body also has a quantifier: `(a+)+`, `(\d*){2,}`. */
const NESTED_QUANTIFIER = new RegExp(String.raw`\(${GROUP_BODY}${QUANT}${GROUP_BODY}\)${QUANT}`);
/** A quantified group with alternation: `(a|aa)+` backtracks exponentially when branches overlap. */
const QUANTIFIED_ALTERNATION = new RegExp(String.raw`\(${GROUP_BODY}\|${GROUP_BODY}\)${QUANT}`);
const BACKREFERENCE = /\\[1-9]|\\k</;

/**
 * Accepts a configurable regex (tenant PII pattern, policy `regex` operator) only when it is
 * short, compiles and has none of the shapes that cause catastrophic backtracking. A heuristic:
 * it rejects some harmless patterns, never the classic ReDoS shapes.
 */
export function isSafeRegex(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return false;
  try {
    new RegExp(pattern);
  } catch {
    return false;
  }
  return !NESTED_QUANTIFIER.test(pattern) && !QUANTIFIED_ALTERNATION.test(pattern) && !BACKREFERENCE.test(pattern);
}
