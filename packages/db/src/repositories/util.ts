export interface Page<T> {
  items: T[];
  total: number;
}

export interface PageOpts {
  limit?: number;
  offset?: number;
}

export const pageLimit = (o: PageOpts) => Math.min(Math.max(o.limit ?? 50, 1), 500);
export const pageOffset = (o: PageOpts) => Math.max(o.offset ?? 0, 0);

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}
