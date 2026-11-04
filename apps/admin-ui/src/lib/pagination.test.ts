import { describe, expect, it } from 'vitest';
import { pageCountOf, pageWindow } from './pagination';

describe('pageWindow', () => {
  it('lists every page when there are few', () => {
    expect(pageWindow(0, 1)).toEqual([0]);
    expect(pageWindow(3, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('keeps first, last and the neighbors of the current page, with gaps', () => {
    expect(pageWindow(10, 20)).toEqual([0, 'gap', 9, 10, 11, 'gap', 19]);
  });

  it('keeps five buttons in a row near the edges', () => {
    expect(pageWindow(0, 20)).toEqual([0, 1, 2, 3, 4, 'gap', 19]);
    expect(pageWindow(3, 20)).toEqual([0, 1, 2, 3, 4, 'gap', 19]);
    expect(pageWindow(19, 20)).toEqual([0, 'gap', 15, 16, 17, 18, 19]);
    expect(pageWindow(16, 20)).toEqual([0, 'gap', 15, 16, 17, 18, 19]);
  });

  it('hides at least two pages behind every gap (a single page would just be shown)', () => {
    for (let count = 8; count <= 30; count++) {
      for (let page = 0; page < count; page++) {
        const w = pageWindow(page, count);
        w.forEach((p, i) => {
          if (p === 'gap') expect((w[i + 1] as number) - (w[i - 1] as number)).toBeGreaterThan(2);
        });
        expect(w).toContain(page);
      }
    }
  });
});

describe('pageCountOf', () => {
  it('has at least one page', () => {
    expect(pageCountOf(0, 25)).toBe(1);
    expect(pageCountOf(25, 25)).toBe(1);
    expect(pageCountOf(26, 25)).toBe(2);
  });
});
