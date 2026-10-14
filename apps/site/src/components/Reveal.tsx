import type { CSSProperties, ReactNode } from 'react';
import { useInView } from '../lib/motion';

/** Fades and slides its content in the first time it scrolls into view. `delay` staggers siblings (ms). */
export function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  const [ref, seen] = useInView<HTMLDivElement>(0.15);
  return (
    <div ref={ref} className={`reveal ${seen ? 'is-visible' : ''} ${className}`} style={{ '--delay': `${delay}ms` } as CSSProperties}>
      {children}
    </div>
  );
}
