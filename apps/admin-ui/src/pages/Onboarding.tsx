import { ArrowRight, CheckCircle2, ChevronDown, ChevronRight, Circle, PartyPopper } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useSession } from '../api/session';
import { Badge, CodeBlock, LivePill, PageHeader, Tabs } from '../components/ui';
import { useT, type T, type UiMessageKey } from '../i18n';
import { omniSnippets, useOnboarding, type ExtraId, type StepId, type StepStatus } from '../lib/onboarding';
import { rich } from '../lib/rich';

/** Menu label of each page the guide links to. */
const PAGE_LABEL: Record<string, UiMessageKey> = {
  '/sources': 'shell.navSources',
  '/tools': 'shell.navTools',
  '/policies': 'shell.navPolicies',
  '/playground': 'shell.navPlayground',
  '/tokens': 'shell.navTokens',
  '/calls': 'shell.navCalls',
  '/servers': 'shell.navServers',
  '/pii': 'shell.navPii',
  '/projections': 'shell.navProjections',
  '/composer': 'shell.navComposer',
  '/observability': 'shell.navObservability',
  '/tenants': 'shell.navTenants',
};

// The examples use the demo HR API (`pnpm dev:upstream`, packages/testkit).
const DEMO_SOURCE = 'hr_demo';

function stepExample(id: StepId, t: T): string {
  switch (id) {
    case 'credential':
      return JSON.stringify({ name: 'hr-demo-key', type: 'api_key', config: { in: 'header', name: 'x-api-key', value: 'fake-api-key' } }, null, 2);
    case 'source':
      return [
        `URL: http://localhost:4010/openapi.json`,
        `${t('common.name')}: ${DEMO_SOURCE}`,
        `${t('sources.baseUrl')}: http://localhost:4010`,
        `${t('sources.credential')}: hr-demo-key`,
      ].join('\n');
    case 'crawl':
      return [`GET /colaboradores/{id}  →  ${DEMO_SOURCE}_colaborador_get`, `GET /escalas           →  ${DEMO_SOURCE}_escalas_list`].join('\n');
    case 'enable':
      return [`${DEMO_SOURCE}_colaborador_get`, `${DEMO_SOURCE}_escalas_list`].join('\n');
    case 'policy':
      return [`${t('common.subjectType')}: role`, `${t('common.subject')}: agent`, `${t('common.effect')}: allow`, `${t('common.tools')}: ${DEMO_SOURCE}_*`].join('\n');
    case 'playground':
      return [`${t('common.tool')}: ${DEMO_SOURCE}_colaborador_get`, `${t('common.arguments')}: {"id": "col-00001"}`, `${t('common.roles')}: agent`].join('\n');
    case 'token':
      return 'export MCP_GATEWAY_TOKEN=mgw_...';
    case 'connect':
      return '';
  }
}

const EXTRA_EXAMPLE: Record<ExtraId, string> = {
  server: `slug: hr-reader  ·  ${DEMO_SOURCE}_*_get, ${DEMO_SOURCE}_*_list  →  /mcp/s/hr-reader`,
  pii: 'cpf → mask  ·  email → mask  ·  salario → drop',
  projection: 'include: $.id, $.nome, $.cargo  ·  max items: 20',
  composite: `${DEMO_SOURCE}_colaborador_get  →  ${DEMO_SOURCE}_escalas_list`,
  observability: 'SRE · Tools · Security · FinOps',
};

const GLOSSARY: Array<{ term: string; to: string | null }> = [
  { term: 'tenant', to: null },
  { term: 'source', to: '/sources' },
  { term: 'tool', to: '/tools' },
  { term: 'states', to: '/tools' },
  { term: 'policy', to: '/policies' },
  { term: 'credential', to: '/sources' },
  { term: 'token', to: '/tokens' },
  { term: 'server', to: '/servers' },
  { term: 'omni', to: '/servers' },
  { term: 'pii', to: '/pii' },
  { term: 'projection', to: '/projections' },
  { term: 'composite', to: '/composer' },
  { term: 'drift', to: '/drift' },
];

export function OnboardingPage() {
  const t = useT();
  const { me } = useSession();
  const ob = useOnboarding({ live: true });
  // `undefined` follows the first pending step; `null` keeps every step closed.
  const [open, setOpen] = useState<StepId | null | undefined>(undefined);
  const openId = open === undefined ? (ob.steps.find((s) => !s.done)?.id ?? null) : open;
  const pct = Math.round((ob.done / ob.total) * 100);

  return (
    <>
      <PageHeader title={t('onboarding.title')} subtitle={t('onboarding.subtitle')} right={<LivePill value={`${ob.done}/${ob.total}`} label={t('onboarding.liveLabel')} />} />
      <div className="content stack onb">
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">{t('onboarding.whatTitle')}</span>
          </div>
          <div className="panel-body stack">
            <p className="onb-lead">{t('onboarding.whatText')}</p>
            <div className="onb-flow" aria-hidden="true">
              <FlowNode title={t('onboarding.flowApi')} hint={t('onboarding.flowApiHint')} />
              <ArrowRight className="onb-arrow" size={22} />
              <FlowNode title={t('onboarding.flowTools')} hint={t('onboarding.flowToolsHint')} />
              <ArrowRight className="onb-arrow" size={22} />
              <FlowNode title={t('onboarding.flowPolicy')} hint={t('onboarding.flowPolicyHint')} />
              <ArrowRight className="onb-arrow" size={22} />
              <FlowNode title={t('onboarding.flowAgent')} hint={t('onboarding.flowAgentHint')} accent />
            </div>
            <div className="onb-pipeline">{t('onboarding.flowPipeline')}</div>
            <p className="muted">{t('onboarding.whatAnalogy')}</p>
            <div>
              <div className="label" style={{ marginBottom: 8 }}>
                {t('onboarding.principlesTitle')}
              </div>
              <div className="chips">
                {(['principleDeny', 'principleCreds', 'principlePii', 'principleContext', 'principleAudit'] as const).map((k) => (
                  <Badge key={k} kind="accent">
                    {t(`onboarding.${k}`)}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">{t('onboarding.checklistTitle')}</span>
            <span className="muted">{t('onboarding.progress', { done: ob.done, total: ob.total })}</span>
          </div>
          <div className="panel-body stack">
            <div className="onb-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t('onboarding.progress', { done: ob.done, total: ob.total })}>
              <span style={{ width: `${pct}%` }} />
            </div>
            <p className="muted">{t('onboarding.checklistHint')}</p>
            <p className="hint">{rich(t, 'onboarding.exampleNote', { command: <span className="mono">pnpm dev:upstream</span> })}</p>
            {ob.essentialComplete && (
              <div className="alert ok row">
                <PartyPopper size={18} />
                <span>{t('onboarding.allDone')}</span>
              </div>
            )}
            <ol className="onb-steps" data-testid="onboarding-steps">
              {ob.steps.map((s, i) => (
                <StepCard
                  key={s.id}
                  n={i + 1}
                  step={s}
                  open={openId === s.id}
                  onToggle={() => setOpen(openId === s.id ? null : s.id)}
                  onMark={(v) => ob.setMarked(s.id, v)}
                  publicUrl={me.publicUrl}
                />
              ))}
            </ol>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">{t('onboarding.extrasTitle')}</span>
            <span className="muted">{t('onboarding.extrasHint')}</span>
          </div>
          <div className="panel-body onb-grid">
            {ob.extras.map((s) => (
              <ExtraCard key={s.id} step={s} onMark={(v) => ob.setMarked(s.id, v)} />
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">{t('onboarding.glossaryTitle')}</span>
            <span className="muted">{t('onboarding.glossaryHint')}</span>
          </div>
          <dl className="panel-body onb-grid onb-glossary">
            {GLOSSARY.map(({ term, to }) => (
              <div key={term} className="onb-card">
                <dt>{to ? <Link to={to}>{t(`onboarding.term.${term}` as UiMessageKey)}</Link> : t(`onboarding.term.${term}` as UiMessageKey)}</dt>
                <dd className="muted">{t(`onboarding.def.${term}` as UiMessageKey)}</dd>
              </div>
            ))}
          </dl>
        </section>

        <label className="check">
          <input type="checkbox" checked={ob.dismissed} onChange={(e) => ob.setDismissed(e.target.checked)} />
          <span>{t('onboarding.hideGuide')}</span>
          <span className="hint">{t('onboarding.hideHint')}</span>
        </label>
      </div>
    </>
  );
}

function FlowNode({ title, hint, accent = false }: { title: string; hint: string; accent?: boolean }) {
  return (
    <div className={`onb-node ${accent ? 'accent' : ''}`}>
      <strong>{title}</strong>
      <span className="hint">{hint}</span>
    </div>
  );
}

function StatusBadge({ step }: { step: StepStatus<string> }) {
  const t = useT();
  if (step.detected) return <Badge kind="ok">{t('onboarding.statusDone')}</Badge>;
  if (step.marked) return <Badge kind="ok">{t('onboarding.statusMarked')}</Badge>;
  return <Badge>{t('onboarding.statusPending')}</Badge>;
}

function RoleNotice({ step }: { step: StepStatus<string> }) {
  const t = useT();
  if (step.canDo || step.done) return null;
  return (
    <div className="alert warn">
      <strong>{t(step.who === 'admin' ? 'onboarding.needsAdmin' : 'onboarding.needsOwner')}.</strong> {t('onboarding.needsRoleHint')}
    </div>
  );
}

function MarkButton({ step, onMark, label }: { step: StepStatus<string>; onMark(v: boolean): void; label?: string }) {
  const t = useT();
  if (!step.manual || step.detected) return null;
  return (
    <button className="btn ghost sm" onClick={() => onMark(!step.marked)}>
      {step.marked ? t('onboarding.unmark') : (label ?? t('onboarding.markDone'))}
    </button>
  );
}

function StepCard({ n, step, open, onToggle, onMark, publicUrl }: { n: number; step: StepStatus; open: boolean; onToggle(): void; onMark(v: boolean): void; publicUrl: string }) {
  const t = useT();
  const bodyId = `onb-step-${step.id}`;
  const example = stepExample(step.id, t);
  return (
    <li className={`onb-step ${step.done ? 'done' : ''}`} data-step={step.id} data-done={step.done}>
      <button className="onb-step-head" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        {step.done ? <CheckCircle2 className="onb-check" size={22} /> : <Circle className="onb-pending" size={22} />}
        <span className="onb-step-num">{t('onboarding.stepN', { n })}</span>
        <span className="onb-step-title">{t(`onboarding.${step.id}.title`)}</span>
        {!step.canDo && !step.done && <Badge kind="warn">{t(step.who === 'admin' ? 'onboarding.needsAdmin' : 'onboarding.needsOwner')}</Badge>}
        <StatusBadge step={step} />
        {open ? <ChevronDown size={18} className="muted" /> : <ChevronRight size={18} className="muted" />}
      </button>
      {open && (
        <div className="onb-step-body" id={bodyId}>
          <div className="stack">
            <RoleNotice step={step} />
            <Block title={t('onboarding.why')}>
              <p>{t(`onboarding.${step.id}.why`)}</p>
            </Block>
            <Block title={t('onboarding.how')}>
              <ol className="onb-how">
                {t(`onboarding.${step.id}.how`)
                  .split('\n')
                  .map((line) => (
                    <li key={line}>{line}</li>
                  ))}
              </ol>
            </Block>
            <div className="row">
              <Link className="btn primary sm" to={step.to}>
                {t('onboarding.open', { page: t(PAGE_LABEL[step.to] ?? 'shell.navTools') })} <ArrowRight size={16} />
              </Link>
              <MarkButton step={step} onMark={onMark} label={step.id === 'credential' ? t('onboarding.credential.manual') : undefined} />
            </div>
          </div>
          <Block title={t('onboarding.example')}>
            <p className="muted">{t(`onboarding.${step.id}.example`)}</p>
            {step.id === 'connect' ? <ConnectSnippets publicUrl={publicUrl} /> : <CodeBlock code={example} />}
          </Block>
        </div>
      )}
    </li>
  );
}

function ConnectSnippets({ publicUrl }: { publicUrl: string }) {
  const t = useT();
  const sn = omniSnippets(publicUrl);
  const [tab, setTab] = useState<'claude' | 'json' | 'curl'>('claude');
  return (
    <div className="stack">
      <blockquote className="onb-prompt">{t('onboarding.connect.prompt')}</blockquote>
      <div className="panel">
        <Tabs<'claude' | 'json' | 'curl'>
          tabs={[
            { id: 'claude', label: 'Claude Code' },
            { id: 'json', label: '.mcp.json' },
            { id: 'curl', label: 'curl' },
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="panel-body" data-testid="onboarding-snippet">
          {tab === 'claude' && <CodeBlock highlightFirstWord code={sn.claude} />}
          {tab === 'json' && <CodeBlock code={sn.claudeJson} />}
          {tab === 'curl' && <CodeBlock code={sn.curl} />}
        </div>
      </div>
    </div>
  );
}

function ExtraCard({ step, onMark }: { step: StepStatus<ExtraId>; onMark(v: boolean): void }) {
  const t = useT();
  return (
    <div className={`onb-card ${step.done ? 'done' : ''}`} data-extra={step.id}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong className="row" style={{ gap: 8 }}>
          {step.done ? <CheckCircle2 className="onb-check" size={18} /> : <Circle className="onb-pending" size={18} />}
          {t(`onboarding.${step.id}.title`)}
        </strong>
        {!step.canDo && !step.done && <Badge kind="warn">{t(step.who === 'admin' ? 'onboarding.needsAdmin' : 'onboarding.needsOwner')}</Badge>}
      </div>
      <p className="muted">{t(`onboarding.${step.id}.why`)}</p>
      <div className="onb-mini mono">{EXTRA_EXAMPLE[step.id]}</div>
      <div className="row">
        <Link className="btn ghost sm" to={step.to}>
          {t('onboarding.open', { page: t(PAGE_LABEL[step.to] ?? 'shell.navTools') })} <ArrowRight size={16} />
        </Link>
        <MarkButton step={step} onMark={onMark} />
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="onb-block">
      <div className="label">{title}</div>
      {children}
    </div>
  );
}
