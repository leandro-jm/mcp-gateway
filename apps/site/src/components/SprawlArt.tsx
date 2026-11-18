import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { useInView, useReducedMotion } from '../lib/motion';

const AGENTS = [40, 90, 140, 190].map((y) => ({ x: 44, y }));
const SERVERS = [30, 72.5, 115, 157.5, 200].map((y) => ({ x: 316, y }));
const HUB = { x: 180, y: 115 };
/** Which agent talks to which server. Point to point, every line is its own integration. */
const LINKS: Array<[number, number]> = [
  [0, 0],
  [0, 2],
  [0, 4],
  [1, 1],
  [1, 3],
  [2, 0],
  [2, 2],
  [2, 4],
  [3, 1],
  [3, 3],
  [3, 4],
];

type Mode = 'before' | 'after';
const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

/**
 * The same agents and servers drawn twice: wired point to point, or through one gateway. Every link
 * bends through a midpoint that slides from the straight line to the hub, so the tangle visibly
 * reorganizes instead of being swapped for another picture.
 */
export function SprawlArt() {
  const t = useT();
  const reduce = useReducedMotion();
  const [ref, seen] = useInView<HTMLDivElement>(0.35);
  const [mode, setMode] = useState<Mode>(reduce ? 'after' : 'before');
  const [k, setK] = useState(reduce ? 1 : 0);
  const touched = useRef(false);

  // First time in view: show the tangle, then reorganize it once.
  useEffect(() => {
    if (!seen || reduce) return;
    const id = setTimeout(() => !touched.current && setMode('after'), 1500);
    return () => clearTimeout(id);
  }, [seen, reduce]);

  useEffect(() => {
    const target = mode === 'after' ? 1 : 0;
    if (reduce) {
      setK(target);
      return;
    }
    let raf = 0;
    let from: number | undefined;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 950);
      setK((cur) => {
        from ??= cur;
        return from + (target - from) * ease(p);
      });
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mode, reduce]);

  const pick = (m: Mode) => {
    touched.current = true;
    setMode(m);
  };

  return (
    <div className={`sprawl ${k > 0.5 ? 'is-after' : 'is-before'}`} ref={ref}>
      <div className="segmented" role="group" aria-label={t('problem.viewLabel')}>
        {(['before', 'after'] as const).map((m) => (
          <button key={m} type="button" className={m === mode ? 'is-active' : ''} aria-pressed={m === mode} onClick={() => pick(m)}>
            {t(m === 'before' ? 'problem.before' : 'problem.after')}
          </button>
        ))}
      </div>
      <svg viewBox="0 0 360 230" className="sprawl-svg" aria-hidden="true">
        <text x={44} y={14} textAnchor="middle" className="cp-heading">
          {t('problem.agents')}
        </text>
        <text x={316} y={14} textAnchor="middle" className="cp-heading">
          {t('problem.servers')}
        </text>
        {LINKS.map(([a, s], i) => {
          const from = AGENTS[a]!;
          const to = SERVERS[s]!;
          const mx = (from.x + to.x) / 2 + (HUB.x - (from.x + to.x) / 2) * k;
          const my = (from.y + to.y) / 2 + (HUB.y - (from.y + to.y) / 2) * k;
          return <path key={i} d={`M${from.x + 9},${from.y} L${mx},${my} L${to.x - 9},${to.y}`} className="sprawl-link" />;
        })}
        {AGENTS.map((p) => (
          <rect key={p.y} x={p.x - 9} y={p.y - 9} width={18} height={18} rx={5} className="sprawl-node" />
        ))}
        {SERVERS.map((p) => (
          <circle key={p.y} cx={p.x} cy={p.y} r={9} className="sprawl-node" />
        ))}
        <g className="sprawl-hub" style={{ opacity: k, transform: `scale(${0.6 + 0.4 * k})` }}>
          <rect x={HUB.x - 21} y={HUB.y - 21} width={42} height={42} rx={10} />
          <g transform={`translate(${HUB.x - 12} ${HUB.y - 12}) scale(0.75)`}>
            <path d="M16 3 28 9.5v13L16 29 4 22.5v-13z" />
            <path d="M4 9.5 16 16l12-6.5M16 16v13" />
          </g>
        </g>
      </svg>
      <p className="sprawl-note" aria-live="polite">
        {mode === 'before' ? t('problem.beforeNote', { count: LINKS.length }) : t('problem.afterNote')}
      </p>
    </div>
  );
}
