import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { CompositeGraph } from '../api/types';
import { useT } from '../i18n';

interface Edge {
  key: string;
  d: string;
}

/**
 * Composite DAG: one column per parallel level and SVG edges for every `$steps.<id>` reference
 * (computed by the gateway). Optional per-step status colors the nodes after a dry-run.
 */
export function Dag({ graph, status }: { graph: CompositeGraph; status?: Record<string, string> }) {
  const t = useT();
  const markerId = useId().replace(/:/g, '');
  const canvas = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const [edges, setEdges] = useState<Edge[]>([]);

  const levels: CompositeGraph['nodes'][] = [];
  for (const n of graph.nodes) (levels[n.level] ??= []).push(n);

  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const layout = () => {
      const box = el.getBoundingClientRect();
      setEdges(
        graph.edges.flatMap((e) => {
          const a = nodes.current.get(e.from)?.getBoundingClientRect();
          const b = nodes.current.get(e.to)?.getBoundingClientRect();
          if (!a || !b) return [];
          const x1 = a.right - box.left;
          const y1 = a.top + a.height / 2 - box.top;
          const x2 = b.left - box.left;
          const y2 = b.top + b.height / 2 - box.top;
          const dx = Math.max(24, (x2 - x1) / 2);
          return [{ key: `${e.from}->${e.to}`, d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}` }];
        }),
      );
    };
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(el);
    return () => ro.disconnect();
  }, [graph]);

  return (
    <div className="dag" data-testid="dag">
      <div className="dag-canvas" ref={canvas}>
        <svg className="dag-edges" aria-hidden="true">
          <defs>
            <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" />
            </marker>
          </defs>
          {edges.map((e) => (
            <path key={e.key} d={e.d} data-edge={e.key} markerEnd={`url(#${markerId})`} />
          ))}
        </svg>
        {levels.map((lvl, i) => (
          <div key={i} className="dag-level">
            {(lvl ?? []).map((n) => (
              <div
                key={n.id}
                data-step={n.id}
                className={`dag-node${status?.[n.id] ? ` status-${status[n.id]}` : ''}`}
                ref={(el) => {
                  if (el) nodes.current.set(n.id, el);
                  else nodes.current.delete(n.id);
                }}
              >
                <div className="id">{n.id}</div>
                <div className="tool">{n.tool}</div>
                {(n.conditional || n.foreach) && (
                  <div className="flags">
                    {n.conditional && <span>{t('composer.nodeWhen')}</span>}
                    {n.foreach && <span>{t('composer.nodeForeach')}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
