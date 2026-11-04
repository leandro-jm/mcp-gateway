import { Table2, LineChart as ChartIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useT } from '../../i18n';

export interface TableData {
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

/**
 * Chart card (ADR-028): title, empty state and a toggle to the same data as a table, which is
 * the accessible equivalent of the chart (every value a tooltip shows is reachable there).
 */
export function ChartFrame({ title, table, empty, right, children }: { title: string; table: TableData; empty?: boolean; right?: ReactNode; children: ReactNode }) {
  const t = useT();
  const [asTable, setAsTable] = useState(false);
  return (
    <figure className="chart">
      <figcaption className="chart-head">
        <span className="chart-title">{title}</span>
        <span className="spacer" />
        {!asTable && right}
        {!empty && (
          <button className="icon-btn" onClick={() => setAsTable((v) => !v)} aria-label={asTable ? t('charts.showChart') : t('charts.showTable')} title={asTable ? t('charts.showChart') : t('charts.showTable')}>
            {asTable ? <ChartIcon size={16} /> : <Table2 size={16} />}
          </button>
        )}
      </figcaption>
      {empty ? (
        <div className="chart-empty muted">{t('charts.noData')}</div>
      ) : asTable ? (
        <div className="chart-table-wrap">
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
        </div>
      ) : (
        children
      )}
    </figure>
  );
}

/** Accessible name of a chart: its title plus the optional description. */
export const chartLabel = (title: string, desc?: string) => (desc ? `${title}. ${desc}` : title);
