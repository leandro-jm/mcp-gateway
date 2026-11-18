import { RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useT } from '../i18n/I18nProvider';
import { useInView, useReducedMotion } from '../lib/motion';

type Kind = 'cmd' | 'ok' | 'prompt' | 'tool' | 'meta' | 'json' | 'deny';
interface Line {
  kind: Kind;
  text: string;
}

const TYPED = new Set<Kind>(['cmd', 'prompt']);
const PREFIX: Partial<Record<Kind, string>> = { cmd: '$ ', prompt: '> ', tool: '● ', meta: '  ⎿ ', deny: '  ⎿ ✕ ', ok: '✓ ' };

/** Colors a `"key": value` JSON line; masked values (with `*`) are highlighted so redaction stands out. */
function renderJson(text: string): ReactNode {
  const m = /^(\s*)"([^"]+)": (.*?)(,?)$/.exec(text);
  if (!m) return text;
  const [, indent, key, value = '', comma] = m;
  return (
    <>
      {indent}
      <span className="tok-key">"{key}"</span>:{' '}
      <span className={value.includes('*') ? 'tok-masked' : 'tok-str'}>{value}</span>
      {comma}
    </>
  );
}

/** Mock agent session: connect with OAuth, an allowed call comes back masked, a destructive call is denied. */
export function Terminal() {
  const t = useT();
  const reduce = useReducedMotion();
  const [ref, seen] = useInView<HTMLDivElement>(0.3);
  const lines = useMemo<Line[]>(
    () => [
      { kind: 'cmd', text: 'claude mcp add --transport http mcp-gateway https://mcp.example.com/mcp/s/hr/omni' },
      { kind: 'ok', text: t('hero.termAdded') },
      { kind: 'meta', text: t('hero.termOauth') },
      { kind: 'ok', text: t('hero.termSigned') },
      { kind: 'prompt', text: t('hero.termPrompt') },
      { kind: 'tool', text: 'search_tools({ query: "colaborador" })' },
      { kind: 'meta', text: `${t('hero.termFound')}: rh_colaborador_get, rh_colaboradores_list, rh_marcacoes_list` },
      { kind: 'tool', text: 'call_tool({ name: "rh_colaborador_get", arguments: { id: "col-00001" } })' },
      { kind: 'meta', text: t('hero.termGoverned') },
      { kind: 'json', text: '{' },
      { kind: 'json', text: '  "nome": "Ana Ribeiro",' },
      { kind: 'json', text: '  "cpf": "***.482.917-**",' },
      { kind: 'json', text: '  "email": "a***@e***.example"' },
      { kind: 'json', text: '}' },
      { kind: 'prompt', text: t('hero.termPrompt2') },
      { kind: 'tool', text: 'call_tool({ name: "rh_marcacao_delete", arguments: { id: "mar-00042" } })' },
      { kind: 'deny', text: t('hero.termDenied') },
    ],
    [t],
  );
  const [pos, setPos] = useState({ line: 0, ch: 0 });

  // A new language replays the session with the translated lines.
  useEffect(() => setPos({ line: 0, ch: 0 }), [lines]);

  useEffect(() => {
    if (!seen) return;
    if (reduce) {
      if (pos.line < lines.length) setPos({ line: lines.length, ch: 0 });
      return;
    }
    const line = lines[pos.line];
    if (!line) return;
    const typed = TYPED.has(line.kind);
    let delay: number;
    let next: { line: number; ch: number };
    if (typed && pos.ch < line.text.length) {
      delay = pos.ch === 0 ? (line.kind === 'prompt' ? 700 : 420) : 14 + Math.random() * 22;
      next = { line: pos.line, ch: Math.min(line.text.length, pos.ch + 2) };
    } else {
      delay = typed ? 160 : line.kind === 'json' ? 55 : line.kind === 'tool' || line.kind === 'deny' ? 520 : 300;
      next = { line: pos.line + 1, ch: 0 };
    }
    const id = setTimeout(() => setPos(next), delay);
    return () => clearTimeout(id);
  }, [seen, reduce, pos, lines]);

  const done = pos.line >= lines.length;
  return (
    <div className="terminal" ref={ref}>
      <div className="terminal-head">
        <span className="dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="mono-label">{t('hero.termTitle')}</span>
        <button type="button" className="icon-btn" onClick={() => setPos({ line: 0, ch: 0 })} disabled={!done} aria-label={t('hero.termReplay')} title={t('hero.termReplay')}>
          <RotateCcw size={14} />
        </button>
      </div>
      <pre className="terminal-body" aria-label={lines.map((l) => (PREFIX[l.kind] ?? '') + l.text).join('\n')}>
        {lines.map((l, i) => {
          if (i > pos.line || (i === pos.line && !TYPED.has(l.kind))) return null;
          const text = i === pos.line ? l.text.slice(0, pos.ch) : l.text;
          return (
            <div key={i} className={`tl tl-${l.kind}`} aria-hidden="true">
              {PREFIX[l.kind] && <span className="tl-prefix">{PREFIX[l.kind]}</span>}
              {l.kind === 'json' ? renderJson(text) : text}
              {i === pos.line && <span className="caret" />}
            </div>
          );
        })}
        {done && (
          <div className="tl" aria-hidden="true">
            <span className="tl-prefix">{'> '}</span>
            <span className="caret blink" />
          </div>
        )}
      </pre>
    </div>
  );
}
