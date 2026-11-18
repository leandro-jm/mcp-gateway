import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';

const REDUCE = '(prefers-reduced-motion: reduce)';

/** True when the visitor asked the OS to minimize motion: loops, typing and counters jump to their final state. */
export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() => window.matchMedia?.(REDUCE).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(REDUCE);
    if (!mq) return;
    const onChange = () => setReduce(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduce;
}

/** Becomes true the first time the element scrolls into view, and stays true. */
export function useInView<E extends Element>(threshold = 0.2): [RefObject<E | null>, boolean] {
  const ref = useRef<E>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (!('IntersectionObserver' in window)) {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold, rootMargin: '0px 0px -8% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, threshold]);
  return [ref, seen];
}

/** True while the element is on screen. Loops run only then, so off-screen sections cost nothing. */
export function useOnScreen<E extends Element>(): [RefObject<E | null>, boolean] {
  const ref = useRef<E>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!('IntersectionObserver' in window)) {
      setOn(true);
      return;
    }
    const io = new IntersectionObserver((entries) => setOn(entries.some((e) => e.isIntersecting)), { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, on];
}

/** Tracks the pointer inside an element as `--mx`/`--my` CSS variables (spotlight and glow effects). */
export function trackPointer(e: PointerEvent<HTMLElement>): void {
  if (window.matchMedia?.(REDUCE).matches) return;
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  el.style.setProperty('--mx', `${e.clientX - r.left}px`);
  el.style.setProperty('--my', `${e.clientY - r.top}px`);
}
