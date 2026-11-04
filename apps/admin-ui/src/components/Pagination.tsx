import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useT } from '../i18n';
import { PAGE_SIZES, pageCountOf, pageWindow, type PaginationState } from '../lib/pagination';
import { fmtNumber } from './ui';

/** Pager under a table (ADR-029): range, page size, previous/next and numbered pages. Hidden when everything fits. */
export function Pagination({ page, pageSize, total, more, onPage, onPageSize }: PaginationState) {
  const t = useT();
  if (!more && total <= (onPageSize ? PAGE_SIZES[0] : pageSize)) return null;
  const pageCount = pageCountOf(total, pageSize);
  const from = total ? page * pageSize + 1 : 0;
  const to = Math.min(total, (page + 1) * pageSize);
  const range = { from: fmtNumber(from), to: fmtNumber(to), total: fmtNumber(total) };
  return (
    <nav className="pager" aria-label={t('common.pagination')}>
      <span className="pager-range">{t(more ? 'common.pageRangeMore' : 'common.pageRange', range)}</span>
      <span className="spacer" />
      {onPageSize && (
        <label className="pager-size">
          {t('common.rowsPerPage')}
          <select className="select" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="pager-pages">
        <button className="btn sm ghost" disabled={page === 0} aria-label={t('common.prevPage')} onClick={() => onPage(page - 1)}>
          <ChevronLeft />
        </button>
        {pageWindow(page, pageCount).map((p, i) =>
          p === 'gap' ? (
            <span key={`gap-${i}`} className="pager-gap" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={p}
              className={`btn sm ghost pager-page${p === page ? ' active' : ''}`}
              aria-current={p === page ? 'page' : undefined}
              aria-label={t('common.goToPage', { page: p + 1 })}
              onClick={() => onPage(p)}
            >
              {fmtNumber(p + 1)}
            </button>
          ),
        )}
        <button className="btn sm ghost" disabled={page >= pageCount - 1} aria-label={t('common.nextPage')} onClick={() => onPage(page + 1)}>
          <ChevronRight />
        </button>
      </div>
    </nav>
  );
}
