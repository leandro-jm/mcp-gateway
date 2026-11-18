import {
  ChartNoAxesColumn,
  Check,
  IdCard,
  LoaderCircle,
  MapPinned,
  RotateCcw,
  ShieldAlert,
  Table2,
  TextCursorInput,
  Workflow,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';
import type { SiteMessageKey } from '../i18n/catalog';
import { useT } from '../i18n/I18nProvider';
import { useOnScreen, useReducedMotion } from '../lib/motion';
import { useTheme } from '../theme/theme';

type View = 'table' | 'chart' | 'card' | 'form' | 'plan' | 'map' | 'diagram';

interface ViewDef {
  id: View;
  icon: LucideIcon;
  label: SiteMessageKey;
  ask: SiteMessageKey;
  reply: SiteMessageKey;
  /** Example tool name. */
  tool: string;
  /** Which `ui://mcp-gateway/*` resource renders it (ADR-022, `resourceFor`). */
  resource: 'view' | 'map' | 'diagram';
  /** `input` views come before the call runs; `result` views show what it returned. */
  phase: 'input' | 'result';
}

const VIEWS: ViewDef[] = [
  { id: 'table', icon: Table2, label: 'genui.viewTable', ask: 'genui.askTable', reply: 'genui.replyTable', tool: 'rh_unidade_headcount', resource: 'view', phase: 'result' },
  { id: 'chart', icon: ChartNoAxesColumn, label: 'genui.viewChart', ask: 'genui.askChart', reply: 'genui.replyChart', tool: 'rh_unidade_headcount', resource: 'view', phase: 'result' },
  { id: 'card', icon: IdCard, label: 'genui.viewCard', ask: 'genui.askCard', reply: 'genui.replyCard', tool: 'rh_colaborador_get', resource: 'view', phase: 'result' },
  { id: 'form', icon: TextCursorInput, label: 'genui.viewForm', ask: 'genui.askForm', reply: 'genui.replyForm', tool: 'rh_marcacao_create', resource: 'view', phase: 'input' },
  { id: 'plan', icon: ShieldAlert, label: 'genui.viewPlan', ask: 'genui.askPlan', reply: 'genui.replyPlan', tool: 'rh_marcacao_delete', resource: 'view', phase: 'input' },
  { id: 'map', icon: MapPinned, label: 'genui.viewMap', ask: 'genui.askMap', reply: 'genui.replyMap', tool: 'rh_unidade_list', resource: 'map', phase: 'result' },
  { id: 'diagram', icon: Workflow, label: 'genui.viewDiagram', ask: 'genui.askDiagram', reply: 'genui.replyDiagram', tool: 'rh_ferias_fluxo_get', resource: 'diagram', phase: 'result' },
];

/** Tenant accents offered by the demo, as [accent, text on accent] per mode. */
const TONES: Array<{ id: string; label: SiteMessageKey; light: [string, string]; dark: [string, string] }> = [
  { id: 'default', label: 'genui.toneDefault', light: ['#18181b', '#ffffff'], dark: ['#fafafa', '#0b0b0c'] },
  { id: 'blue', label: 'genui.toneBlue', light: ['#1d4ed8', '#ffffff'], dark: ['#60a5fa', '#0b0b0c'] },
  { id: 'teal', label: 'genui.toneTeal', light: ['#0f766e', '#ffffff'], dark: ['#2dd4bf', '#0b0b0c'] },
  { id: 'orange', label: 'genui.toneOrange', light: ['#c2410c', '#ffffff'], dark: ['#fb923c', '#0b0b0c'] },
];

/** Example rows only: the demo is an illustration, not product data. */
const UNITS = [
  { name: 'São Paulo', people: 128, open: 6, x: 232, y: 138 },
  { name: 'Curitiba', people: 74, open: 2, x: 204, y: 166 },
  { name: 'Recife', people: 52, open: 3, x: 312, y: 70 },
  { name: 'Manaus', people: 31, open: 1, x: 96, y: 48 },
];
const MAX = UNITS[0]!.people;

const stagger = (i: number) => ({ '--i': i }) as CSSProperties;

function TableView() {
  const t = useT();
  return (
    <table className="view-table">
      <thead>
        <tr>
          <th>{t('genui.colUnit')}</th>
          <th className="num">{t('genui.colPeople')}</th>
          <th className="num">{t('genui.colOpen')}</th>
        </tr>
      </thead>
      <tbody>
        {UNITS.map((u, i) => (
          <tr key={u.name} className="gx-in" style={stagger(i)}>
            <td>{u.name}</td>
            <td className="num">{u.people}</td>
            <td className="num">{u.open}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ChartView() {
  const t = useT();
  return (
    <div className="view-chart">
      <p className="gx-view-title">{t('genui.chartTitle')}</p>
      {UNITS.map((u, i) => (
        <div key={u.name} className="view-bar-row">
          <span>{u.name}</span>
          <span className="gx-bar">
            <i style={{ width: `${(u.people / MAX) * 100}%`, ...stagger(i) }} />
          </span>
          <b>{u.people}</b>
        </div>
      ))}
    </div>
  );
}

function CardView() {
  const t = useT();
  return (
    <div className="gx-card">
      <span className="gx-avatar" aria-hidden="true">
        AS
      </span>
      <div className="gx-card-id">
        <b>Ana Souza</b>
        <span>{t('genui.cardRole')} · col-00001</span>
      </div>
      <dl className="gx-fields">
        <div className="gx-in" style={stagger(0)}>
          <dt>{t('genui.cardUnit')}</dt>
          <dd>São Paulo</dd>
        </div>
        <div className="gx-in" style={stagger(1)}>
          <dt>{t('genui.cardSince')}</dt>
          <dd>2021</dd>
        </div>
        <div className="gx-in" style={stagger(2)}>
          <dt>{t('genui.cardTaxId')}</dt>
          <dd>
            <code>***.***.***-**</code>
            <span className="pill pill-mask">{t('genui.cardMasked')}</span>
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** The gateway sends the form back prefilled with the field error; here the visitor "fixes" it after a moment. */
function FormView({ animate }: { animate: boolean }) {
  const t = useT();
  const [fixed, setFixed] = useState(false);
  useEffect(() => {
    if (!animate) return;
    const id = setTimeout(() => setFixed(true), 3800);
    return () => clearTimeout(id);
  }, [animate]);
  return (
    <div className="gx-form">
      <p className="gx-view-title">{t('genui.formTitle')}</p>
      <div className="gx-form-grid">
        <div className="gx-field">
          <span>{t('genui.formEmployee')}</span>
          <span className="gx-input">col-00001</span>
        </div>
        <div className="gx-field">
          <span>{t('genui.formDate')}</span>
          <span className="gx-input">2026-03-14</span>
        </div>
        <div className={`gx-field ${fixed ? 'is-ok' : 'is-error'}`}>
          <span>{t('genui.formHours')}</span>
          <span className="gx-input" key={String(fixed)}>
            {fixed ? '8' : '25'}
            {fixed && <Check size={14} />}
          </span>
          <small>{fixed ? ' ' : t('genui.formError')}</small>
        </div>
        <span className={`gx-btn ${fixed ? '' : 'is-disabled'}`}>{t('genui.formSubmit')}</span>
      </div>
    </div>
  );
}

/** Nothing runs until the visitor clicks: the same gate the gateway puts in front of destructive tools. */
function PlanView({ onTouch }: { onTouch: () => void }) {
  const t = useT();
  const [decision, setDecision] = useState<'approved' | 'cancelled' | null>(null);
  const decide = (d: 'approved' | 'cancelled' | null) => {
    onTouch();
    setDecision(d);
  };
  return (
    <div className="gx-plan">
      <div className="gx-plan-head">
        <ShieldAlert size={18} />
        <div>
          <b>{t('genui.confirmTitle')}</b>
          <p>{t('genui.confirmBody')}</p>
        </div>
      </div>
      <ol className="gx-steps">
        {(['genui.planStep1', 'genui.planStep2'] as const).map((k, i) => (
          <li key={k} className={`gx-in ${decision === 'approved' ? 'is-done' : ''}`} style={stagger(i)}>
            <span className="gx-step-n">{decision === 'approved' ? <Check size={12} /> : i + 1}</span>
            {t(k)}
          </li>
        ))}
      </ol>
      {decision === null ? (
        <div className="view-actions">
          <button type="button" className="gx-btn gx-ping" onClick={() => decide('approved')}>
            {t('genui.approve')}
          </button>
          <button type="button" className="gx-btn gx-btn-ghost" onClick={() => decide('cancelled')}>
            {t('genui.cancel')}
          </button>
        </div>
      ) : (
        <div className={`gx-outcome is-${decision}`} role="status">
          {decision === 'approved' ? <Check size={15} /> : <X size={15} />}
          <span>{t(decision === 'approved' ? 'genui.approved' : 'genui.cancelled')}</span>
          <button type="button" className="gx-reset" onClick={() => decide(null)} aria-label={t('genui.reset')} title={t('genui.reset')}>
            <RotateCcw size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function MapView() {
  const t = useT();
  return (
    <svg className="gx-map" viewBox="0 0 360 200" role="img" aria-label={t('genui.mapTitle')}>
      <path className="gx-land" d="M62 34 Q120 6 190 22 Q262 20 322 54 Q342 78 318 104 Q292 128 268 150 Q236 190 204 190 Q178 186 176 156 Q138 140 98 118 Q52 96 62 34Z" />
      <path className="gx-road" d="M96 48 Q170 70 232 138 M312 70 Q280 110 232 138 M232 138 L204 166 M96 48 Q210 40 312 70" />
      {UNITS.map((u, i) => {
        const r = 5 + (u.people / MAX) * 7;
        const left = u.x > 280;
        return (
          <g key={u.name} className="gx-pin gx-in" style={stagger(i)}>
            <circle className="gx-pin-ring" cx={u.x} cy={u.y} r={r} />
            <circle className="gx-pin-dot" cx={u.x} cy={u.y} r={r} />
            <text x={left ? u.x - r - 6 : u.x + r + 6} y={u.y - 1} textAnchor={left ? 'end' : 'start'}>
              {u.name}
            </text>
            <text className="gx-pin-val" x={left ? u.x - r - 6 : u.x + r + 6} y={u.y + 12} textAnchor={left ? 'end' : 'start'}>
              {u.people}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function DiagramView() {
  const t = useT();
  const node = (x: number, y: number, label: string, cls = '') => (
    <g className={`gx-node ${cls}`}>
      <rect x={x} y={y} width={92} height={36} rx={8} />
      <text x={x + 46} y={y + 22} textAnchor="middle">
        {label}
      </text>
    </g>
  );
  return (
    <svg className="gx-diagram" viewBox="0 0 360 170" role="img" aria-label={t('genui.flowTitle')}>
      <g className="gx-edge" style={stagger(0)}>
        <path d="M100 38 H128" pathLength={1} />
        <path className="gx-head" d="M126 33 l8 5 -8 5z" />
      </g>
      <g className="gx-edge" style={stagger(1)}>
        <path d="M226 38 H254" pathLength={1} />
        <path className="gx-head" d="M252 33 l8 5 -8 5z" />
      </g>
      <g className="gx-edge is-no" style={stagger(2)}>
        <path d="M180 56 V106" pathLength={1} />
        <path className="gx-head" d="M175 104 l5 8 5 -8z" />
      </g>
      <g className="gx-edge is-yes" style={stagger(3)}>
        <path d="M306 56 V106" pathLength={1} />
        <path className="gx-head" d="M301 104 l5 8 5 -8z" />
      </g>
      {node(8, 20, t('genui.flowRequest'))}
      {node(134, 20, t('genui.flowManager'))}
      {node(260, 20, t('genui.flowHr'))}
      {node(134, 114, t('genui.flowRejected'), 'is-no')}
      {node(260, 114, t('genui.flowApproved'), 'is-yes')}
    </svg>
  );
}

/** What the gateway sends for the current view, and who reads each part (ADR-022). */
function Wire({ def, accent }: { def: ViewDef; accent: { light: string; dark: string } }) {
  const t = useT();
  const side = def.phase === 'input' ? 'input' : 'result';
  const extra = def.id === 'plan' ? ', confirmToken: "••••••"' : def.id === 'form' ? ', errors: { hours: "…" }' : '';
  const model = <span className="wtag">{t('genui.wireModel')}</span>;
  const view = <span className="wtag wtag-view">{t('genui.wireView')}</span>;
  return (
    <div className="wire">
      <p className="mono-label">{t('genui.wireTitle')}</p>
      <div className="wire-code">
        <p className="wire-c">{'// tools/list'}</p>
        <p>_meta.ui.resourceUri</p>
        <p className="wire-v" key={`uri-${def.resource}`}>
          "ui://mcp-gateway/{def.resource}"
        </p>
        <p className="wire-c">{'// tools/call'}</p>
        <p>content {model}</p>
        <p>structuredContent {model}</p>
        <p>_meta[".../views"] {view}</p>
        <p className="wire-v" key={`views-${def.id}`}>
          {`{ views: { ${side}: { kind: "${def.id}" } },`}
          <br />
          {`  phase: "${def.phase}"${extra} }`}
        </p>
        <p>_meta[".../theme"] {view}</p>
        <p className="wire-v" key={`theme-${accent.dark}`}>
          {`{ accent: { light: "${accent.light}",`}
          <br />
          {`  dark: "${accent.dark}" } }`}
        </p>
      </div>
      <p className="wire-zero">
        <b>0</b>
        <span>{t('genui.wireZero')}</span>
      </p>
    </div>
  );
}

/**
 * Mock chat in an MCP Apps host: the visitor picks one of the seven view kinds and a tenant accent, and
 * sees both the rendered view and what travels on the wire. It cycles on its own until someone touches it.
 */
export function GenUiDemo() {
  const t = useT();
  const reduce = useReducedMotion();
  const { resolved } = useTheme();
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const [view, setView] = useState<View>('table');
  const [tone, setTone] = useState('default');
  const [touched, setTouched] = useState(false);

  const def = VIEWS.find((v) => v.id === view)!;
  const toneDef = TONES.find((x) => x.id === tone)!;
  const [accent, accentFg] = toneDef[resolved];
  const auto = !touched && !reduce;
  const next = () => setView(VIEWS[(VIEWS.findIndex((v) => v.id === view) + 1) % VIEWS.length]!.id);

  return (
    <div className={`gx beam is-always ${on ? '' : 'is-off'}`} ref={ref} style={{ '--va': accent, '--va-fg': accentFg } as CSSProperties}>
      <div className="gx-tabs" role="group" aria-label={t('genui.demoPick')}>
        {VIEWS.map((v) => {
          const Icon = v.icon;
          const active = v.id === view;
          return (
            <button
              key={v.id}
              type="button"
              className={active ? 'is-active' : ''}
              aria-pressed={active}
              onClick={() => {
                setTouched(true);
                setView(v.id);
              }}
            >
              <Icon size={15} />
              {t(v.label)}
              {/* The progress bar is the autoplay clock: when its animation ends, the next view shows. */}
              {active && auto && <i className="gx-progress" onAnimationEnd={next} />}
            </button>
          );
        })}
      </div>
      <div className="gx-main">
        <div className="gx-chat">
          <div className="gx-chat-head">
            <span className="mono-label">{t('genui.demoTitle')}</span>
            <span className="genui-note">{t('genui.demoNote')}</span>
          </div>
          <div className="gx-thread" key={view}>
            <div className="bubble">{t(def.ask)}</div>
            <div className="toolcall">
              <span className="gx-status" aria-hidden="true">
                <LoaderCircle size={13} className="gx-spin" />
                <Check size={13} className="gx-done" />
              </span>
              <Wrench size={13} />
              <code>{def.tool}</code>
            </div>
            <div className="view-card">
              <div className="gx-frame-bar">
                <code>ui://mcp-gateway/{def.resource}</code>
                <span>{t('genui.frame')}</span>
              </div>
              {view === 'table' && <TableView />}
              {view === 'chart' && <ChartView />}
              {view === 'card' && <CardView />}
              {view === 'form' && <FormView animate={!reduce} />}
              {view === 'plan' && <PlanView onTouch={() => setTouched(true)} />}
              {view === 'map' && <MapView />}
              {view === 'diagram' && <DiagramView />}
            </div>
            <p className="gx-reply">{t(def.reply)}</p>
          </div>
        </div>
        <aside className="gx-side">
          <div className="gx-tones-row">
            <span className="mono-label">{t('genui.themePick')}</span>
            <div className="gx-tones" role="group" aria-label={t('genui.themePick')}>
              {TONES.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  className={x.id === tone ? 'is-active' : ''}
                  aria-pressed={x.id === tone}
                  aria-label={t(x.label)}
                  title={t(x.label)}
                  style={{ '--sw': x[resolved][0] } as CSSProperties}
                  onClick={() => {
                    setTouched(true);
                    setTone(x.id);
                  }}
                />
              ))}
            </div>
          </div>
          <Wire def={def} accent={{ light: toneDef.light[0], dark: toneDef.dark[0] }} />
        </aside>
      </div>
    </div>
  );
}
