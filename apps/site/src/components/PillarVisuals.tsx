import { formatNumber } from '@mcp-gateway/i18n';
import { useEffect, useState } from 'react';
import { useI18n, useT } from '../i18n/I18nProvider';
import { useOnScreen, useReducedMotion } from '../lib/motion';

/** Ticks `step` up by one every `ms` while the element is on screen (never under reduced motion). */
function useLoop(ms: number, active: boolean): number {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setStep((s) => s + 1), ms);
    return () => clearInterval(id);
  }, [ms, active]);
  return step;
}

/** Access: a policy list where one rule flips between deny and allow. */
export function AccessViz() {
  const reduce = useReducedMotion();
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const allow = useLoop(2200, on && !reduce) % 2 === 1 || reduce;
  const rows: Array<{ who: string; what: string; allow: boolean; live?: boolean }> = [
    { who: 'role:agent', what: 'hr_*', allow: true },
    { who: 'oauth:claude.ai', what: 'fin_invoice_get', allow, live: true },
    { who: 'role:agent', what: 'hr_timeentry_delete', allow: false },
  ];
  return (
    <div className="viz viz-access" ref={ref} aria-hidden="true">
      {rows.map((r) => (
        <div key={r.what} className={`rule ${r.live ? 'is-live' : ''}`}>
          <code>{r.who}</code>
          <span className="rule-arrow">→</span>
          <code className="rule-what">{r.what}</code>
          {r.live && (
            <span className={`switch ${r.allow ? 'is-on' : ''}`}>
              <i />
            </span>
          )}
          <span className={`pill ${r.allow ? 'pill-allow' : 'pill-deny'}`}>{r.allow ? 'allow' : 'deny'}</span>
        </div>
      ))}
    </div>
  );
}

const RAW = [
  { key: 'cpf', raw: '529.982.247-25', masked: '***.982.247-**' },
  { key: 'email', raw: 'ana@example.com', masked: 'a***@e***.com' },
];
const SWEEP = 16;

/** Data: personal values masked character by character on their way to the model. */
export function DataViz() {
  const t = useT();
  const reduce = useReducedMotion();
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const step = useLoop(70, on && !reduce);
  // hold raw, sweep, hold masked
  const phase = step % (SWEEP + 48);
  const p = reduce ? SWEEP : Math.max(0, Math.min(SWEEP, phase - 12));
  const done = p >= SWEEP;
  return (
    <div className="viz viz-data" ref={ref} aria-hidden="true">
      <div className="viz-caption">
        <span className={done ? '' : 'is-on'}>{t('pillars.dataFrom')}</span>
        <span className="rule-arrow">→</span>
        <span className={done ? 'is-on' : ''}>{t('pillars.dataTo')}</span>
      </div>
      {RAW.map((r) => {
        const head = r.masked.slice(0, done ? r.masked.length : p);
        const tail = done ? '' : r.raw.slice(p);
        return (
          <div key={r.key} className="json-line">
            <span className="tok-key">"{r.key}"</span>: "
            {[...head].map((c, i) => (
              <span key={i} className={c === '*' ? 'tok-masked' : undefined}>
                {c}
              </span>
            ))}
            {tail}"
          </div>
        );
      })}
    </div>
  );
}

/** docs/perf/agent-bench-2026-11-04.md: tool-definition tokens per call, direct vs Omni. */
const DIRECT_TOKENS = 108_351;
const OMNI_TOKENS = 1_512;

/** Context and cost: the definition tokens drop from the whole catalog to the Omni meta-tools. */
export function CostViz() {
  const t = useT();
  const { locale } = useI18n();
  const reduce = useReducedMotion();
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const step = useLoop(50, on && !reduce);
  // hold full, fall, hold low
  const phase = step % 150;
  const k = reduce ? 1 : Math.max(0, Math.min(1, (phase - 20) / 40));
  const eased = 1 - Math.pow(1 - k, 3);
  const value = Math.round(DIRECT_TOKENS + (OMNI_TOKENS - DIRECT_TOKENS) * eased);
  return (
    <div className="viz viz-cost" ref={ref} aria-hidden="true">
      <div className="viz-caption">
        <span className="is-on">{t('pillars.costMeter')}</span>
      </div>
      <div className="meter-row">
        <span className="meter-label">{t('pillars.costDirect')}</span>
        <span className="meter-bar">
          <i className="meter-direct" style={{ width: '100%' }} />
        </span>
        <span className="meter-value">{formatNumber(locale, DIRECT_TOKENS)}</span>
      </div>
      <div className="meter-row">
        <span className="meter-label">{t('pillars.costOmni')}</span>
        <span className="meter-bar">
          <i className="meter-omni" style={{ width: `${Math.max(1.4, (value / DIRECT_TOKENS) * 100)}%` }} />
        </span>
        <span className="meter-value is-strong">{formatNumber(locale, value)}</span>
      </div>
      <div className="viz-foot">{t('pillars.costNote')}</div>
    </div>
  );
}

type Outcome = 'allow' | 'deny' | 'mask';
const EVENTS: Array<{ outcome: Outcome; tool: string; client: string; ms: number }> = [
  { outcome: 'allow', tool: 'hr_schedules_list', client: 'claude-code', ms: 9 },
  { outcome: 'mask', tool: 'hr_employee_get', client: 'oauth:claude.ai', ms: 12 },
  { outcome: 'deny', tool: 'hr_timeentry_delete', client: 'support-bot', ms: 2 },
  { outcome: 'allow', tool: 'fin_invoice_get', client: 'oauth:chatgpt.com', ms: 14 },
  { outcome: 'mask', tool: 'crm_customer_search', client: 'support-bot', ms: 11 },
  { outcome: 'allow', tool: 'crm_ticket_reply', client: 'support-bot', ms: 16 },
  { outcome: 'deny', tool: 'fin_payments_list', client: 'claude-code', ms: 2 },
];
const LABEL: Record<Outcome, string> = { allow: 'allow', deny: 'deny', mask: 'masked' };
const VISIBLE = 4;

/** Visibility: an illustrative stream of call events, newest on top. */
export function EventFeed() {
  const t = useT();
  const reduce = useReducedMotion();
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const step = useLoop(1500, on && !reduce);
  const rows = Array.from({ length: VISIBLE }, (_, i) => {
    const n = step + VISIBLE - 1 - i;
    return { n, ...EVENTS[n % EVENTS.length]! };
  });
  return (
    <div className="viz viz-feed" ref={ref} aria-hidden="true">
      <div className="feed-rows">
        {rows.map((r) => (
          <div key={r.n} className="feed-row">
            <span className={`pill pill-${r.outcome}`}>{LABEL[r.outcome]}</span>
            <code>{r.tool}</code>
            <span className="feed-client">{r.client}</span>
            <span className="feed-ms">{r.ms} ms</span>
          </div>
        ))}
      </div>
      <div className="viz-foot">{t('pillars.seeNote')}</div>
    </div>
  );
}
