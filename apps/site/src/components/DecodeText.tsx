import { useEffect, useState } from 'react';
import { useReducedMotion } from '../lib/motion';

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/<>{}[]#*+=';

function scramble(text: string, revealed: number): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    out += i < revealed || c === ' ' || c === ',' || c === '.' ? c : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
  }
  return out;
}

/** Text that "decodes" from random glyphs, left to right. Screen readers get the final text only. */
export function DecodeText({ text, delay = 0 }: { text: string; delay?: number }) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(text);

  useEffect(() => {
    if (reduce) {
      setShown(text);
      return;
    }
    const frames = 26;
    let frame = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    setShown(scramble(text, 0));
    const start = setTimeout(() => {
      timer = setInterval(() => {
        frame++;
        if (frame >= frames) {
          clearInterval(timer);
          setShown(text);
        } else setShown(scramble(text, Math.floor((frame / frames) * text.length)));
      }, 34);
    }, delay);
    return () => {
      clearTimeout(start);
      clearInterval(timer);
    };
  }, [text, delay, reduce]);

  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">{shown}</span>
    </>
  );
}
