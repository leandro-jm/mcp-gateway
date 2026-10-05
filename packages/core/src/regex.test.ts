import { describe, expect, it } from 'vitest';
import { isSafeRegex, MAX_PATTERN_LENGTH } from './regex';

describe('isSafeRegex', () => {
  it.each(['^col-\\d+$', '\\d{4,6}-\\d', '^[A-Z]{2}\\d{2}$', '(foo|bar)', 'conta:?\\s*\\d{5,12}', '^(\\d{3})\\.(\\d{3})$'])('accepts %s', (p) =>
    expect(isSafeRegex(p)).toBe(true),
  );

  it.each(['(a+)+$', '(\\d*)*', '(x+x+)+y', '(a|aa)+', '(a|a)*b', '([a-z]+){2,}', '(a)\\1', '[', 'a'.repeat(MAX_PATTERN_LENGTH + 1)])('rejects %s', (p) =>
    expect(isSafeRegex(p)).toBe(false),
  );
});
