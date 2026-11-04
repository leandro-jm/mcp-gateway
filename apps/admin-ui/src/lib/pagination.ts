import { useState, useSyncExternalStore } from 'react';

export const PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;
/** Tables inside panels, drawers and chart twins: fixed size, no size selector. */
export const COMPACT_PAGE_SIZE = 10;

export type PageItem = number | 'gap';

/** Page buttons to show (0-based): first, last and the current one with its neighbors, gaps in between. */
export function pageWindow(page: number, pageCount: number): PageItem[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i);
  const keep = new Set([0, pageCount - 1, page - 1, page, page + 1]);
  // near the edges, keep five buttons in a row so the bar does not change width
  if (page <= 3) [1, 2, 3, 4].forEach((p) => keep.add(p));
  if (page >= pageCount - 4) [pageCount - 5, pageCount - 4, pageCount - 3, pageCount - 2].forEach((p) => keep.add(p));
  const pages = [...keep].filter((p) => p >= 0 && p < pageCount).sort((a, b) => a - b);
  const out: PageItem[] = [];
  pages.forEach((p, i) => {
    if (i > 0 && p - pages[i - 1]! > 1) out.push('gap');
    out.push(p);
  });
  return out;
}

export const pageCountOf = (total: number, size: number) => Math.max(1, Math.ceil(total / size));

// the page size is a per-browser preference shared by every full-size table
const SIZE_KEY = 'mcp-gw:page-size';
const listeners = new Set<() => void>();
let stored: number | null = null;

function readSize(): number {
  if (stored !== null) return stored;
  stored = DEFAULT_PAGE_SIZE;
  try {
    const n = Number(localStorage.getItem(SIZE_KEY));
    if ((PAGE_SIZES as readonly number[]).includes(n)) stored = n;
  } catch {
    /* storage unavailable */
  }
  return stored;
}

function writeSize(n: number) {
  stored = n;
  try {
    localStorage.setItem(SIZE_KEY, String(n));
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePageSize(): [number, (n: number) => void] {
  return [useSyncExternalStore(subscribe, readSize, readSize), writeSize];
}

export interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
  /** Rows exist past `total` (cursor lists): the range reads "1–25 of 50+". */
  more?: boolean;
  onPage(page: number): void;
  /** Absent on compact tables: no size selector. */
  onPageSize?(size: number): void;
}

/**
 * Controlled page state that resets to the first page when `reset` changes (search, filters) and
 * never points past the last page when the list shrinks.
 */
export function usePageState(total: number, opts: { reset?: unknown; compact?: boolean } = {}) {
  const [preferred, setPreferred] = usePageSize();
  const pageSize = opts.compact ? COMPACT_PAGE_SIZE : preferred;
  const key = JSON.stringify(opts.reset ?? null);
  const [state, setState] = useState({ key, page: 0 });
  const raw = state.key === key ? state.page : 0;
  const page = Math.min(raw, pageCountOf(total, pageSize) - 1);
  const pager: PaginationState = {
    page,
    pageSize,
    total,
    onPage: (p) => setState({ key, page: p }),
    ...(opts.compact
      ? {}
      : {
          onPageSize: (n: number) => {
            setPreferred(n);
            setState({ key, page: 0 });
          },
        }),
  };
  return pager;
}

/** Client-side pagination over a list already in memory: the visible slice plus the pager props. */
export function usePagination<T>(rows: readonly T[], opts: { reset?: unknown; compact?: boolean } = {}) {
  const pager = usePageState(rows.length, opts);
  const start = pager.page * pager.pageSize;
  return { rows: rows.slice(start, start + pager.pageSize), pager };
}
