import { Table2, LineChart as ChartIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';

export const SERIES_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'];

export interface TableData {
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

/**
 * Accessible chart frame (ADR-018): title, `<title>`/`<desc>` on the SVG and a toggle to the
 * same data as a table.
 */
export function ChartFrame({
  title,
  desc,
  table,
  empty,
  right,
  children,
}: {
  title: string;
  desc?: string;
  table: TableData;
  empty?: boolean;
  right?: ReactNode;
  children: (ids: { titleId: string; descId: string }) => ReactNode;
}) {
  const t = useT();
  const [asTable, setAsTable] = useState(false);
  const id = useId().replace(/:/g, '');
  const ids = { titleId: `${id}-t`, descId: `${id}-d` };
  return (
    <figure className="chart">
      <figcaption className="chart-head">
        <span className="chart-title">{title}</span>
        <span className="spacer" />
        {right}
        {!empty && (
          <button className="icon-btn" onClick={() => setAsTable((v) => !v)} aria-label={asTable ? t('charts.showChart') : t('charts.showTable')} title={asTable ? t('charts.showChart') : t('charts.showTable')}>
            {asTable ? <ChartIcon size={16} /> : <Table2 size={16} />}
          </button>
        )}
      </figcaption>
      {empty ? (
        <div className="chart-empty muted">{t('charts.noData')}</div>
      ) : asTable ? (
        <table className="table chart-table">
          <thead>
            <tr>
              {table.columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td key={j} className={typeof v === 'number' ? 'mono' : undefined}>
                    {v ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          {children(ids)}
          <span id={ids.descId} className="sr-only">
            {desc ?? title}
          </span>
        </>
      )}
    </figure>
  );
}

/** "Nice" upper bound for an axis. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  const f = max / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}
