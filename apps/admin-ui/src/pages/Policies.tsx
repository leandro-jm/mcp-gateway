import { useMutation } from '@tanstack/react-query';
import { List, ShieldQuestion, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { useSession } from '../api/session';
import type { Decision, Page, Policy, Tool } from '../api/types';
import { Editor } from '../components/Editor';
import { useToast } from '../components/toast';
import { Badge, Drawer, ErrorBox, Field, LivePill, PageHeader, Tabs } from '../components/ui';
import { useT } from '../i18n';
import { useInvalidate, useTenantQuery } from '../lib/hooks';
import { EFFECT_LABEL, enumLabel } from '../lib/labels';
import { parseJson } from '../lib/schema';

type Tab = 'list' | 'simulate';

/** Example of the conditions syntax (code, not translated). */
const CONDITIONS_EXAMPLE = '{ "timeWindows": [{"days":["mon"],"start":"08:00","end":"18:00"}], "args": ["args.unidade_id in claims.unidades"], "rate": {"limit": 10} }';

export function PoliciesPage() {
  const t = useT();
  const { me } = useSession();
  const [tab, setTab] = useState<Tab>('list');
  const [edit, setEdit] = useState<Policy | 'new' | null>(null);
  const policies = useTenantQuery<{ items: Policy[] }>(['policies'], '/policies');
  const invalidate = useInvalidate();
  const toast = useToast();
  const remove = useMutation({
    mutationFn: (id: string) => api(`/policies/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('ok', t('policies.removed'));
      void invalidate('policies');
    },
  });
  const items = policies.data?.items ?? [];
  return (
    <>
      <PageHeader title={t('policies.title')} subtitle={t('policies.subtitle')} right={<LivePill value={items.length} label={t('policies.rules')} />} />
      <Tabs<Tab>
        tabs={[
          { id: 'list', label: t('policies.rules'), icon: <List size={20} /> },
          { id: 'simulate', label: t('policies.simulator'), icon: <ShieldQuestion size={20} /> },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="content">
        {tab === 'list' && (
          <>
            <div className="toolbar">
              <span className="count-label" style={{ paddingLeft: 0 }}>
                {t('policies.count', { count: items.length })}
              </span>
              <span className="spacer" />
              {me.isAdmin && (
                <button className="btn primary" onClick={() => setEdit('new')}>
                  {t('policies.newRule')}
                </button>
              )}
            </div>
            <ErrorBox error={policies.error} />
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.effect')}</th>
                  <th>{t('common.subject')}</th>
                  <th>{t('common.tools')}</th>
                  <th>{t('common.conditions')}</th>
                  <th>{t('common.priority')}</th>
                  <th>{t('common.description')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id} className={me.isAdmin ? 'clickable' : ''} onClick={() => me.isAdmin && setEdit(p)}>
                    <td>
                      <Badge kind={p.effect}>{enumLabel(t, EFFECT_LABEL, p.effect)}</Badge>
                    </td>
                    <td className="mono">
                      <span className="muted">{p.subjectType}:</span>
                      {p.subject}
                    </td>
                    <td className="mono">{p.toolPattern}</td>
                    <td className="mono muted" style={{ fontSize: 12 }}>
                      {Object.keys(p.conditions).length ? JSON.stringify(p.conditions) : '—'}
                    </td>
                    <td className="mono">{p.priority}</td>
                    <td className="muted">{p.description ?? ''}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {me.isAdmin && (
                        <button className="btn sm ghost" aria-label={t('common.remove')} onClick={() => remove.mutate(p.id)}>
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {tab === 'simulate' && <Simulator />}
      </div>
      {edit && <PolicyEditor policy={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function PolicyEditor({ policy, onClose }: { policy: Policy | null; onClose(): void }) {
  const t = useT();
  const invalidate = useInvalidate();
  const toast = useToast();
  const [form, setForm] = useState({
    subjectType: policy?.subjectType ?? 'role',
    subject: policy?.subject ?? '',
    effect: policy?.effect ?? 'allow',
    toolPattern: policy?.toolPattern ?? '',
    priority: String(policy?.priority ?? 0),
    description: policy?.description ?? '',
    conditions: JSON.stringify(policy?.conditions ?? {}, null, 2),
  });
  const save = useMutation({
    mutationFn: () => {
      const c = parseJson<Record<string, unknown>>(form.conditions);
      if (c.error) throw new Error(t('policies.invalidConditions', { error: c.error }));
      const body = { ...form, priority: Number(form.priority), conditions: c.value, description: form.description || null };
      return policy ? api(`/policies/${policy.id}`, { method: 'PATCH', body }) : api('/policies', { method: 'POST', body });
    },
    onSuccess: () => {
      toast('ok', t('policies.saved'));
      void invalidate('policies');
      onClose();
    },
  });
  return (
    <Drawer title={policy ? t('policies.editRule') : t('policies.newRule')} onClose={onClose}>
      <div className="drawer-body">
        <div className="grid-2">
          <Field label={t('common.subjectType')}>
            <select className="select" value={form.subjectType} onChange={(e) => setForm({ ...form, subjectType: e.target.value as Policy['subjectType'] })} aria-label={t('common.subjectType')}>
              {['role', 'group', 'client', 'user'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label={t('common.subject')} hint={t('policies.subjectHint')}>
            <input className="input mono" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} aria-label={t('common.subject')} />
          </Field>
          <Field label={t('common.effect')}>
            <select className="select" value={form.effect} onChange={(e) => setForm({ ...form, effect: e.target.value as 'allow' | 'deny' })} aria-label={t('common.effect')}>
              {(['allow', 'deny'] as const).map((effect) => (
                <option key={effect} value={effect}>
                  {enumLabel(t, EFFECT_LABEL, effect)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('common.tools')} hint={t('policies.toolPatternHint')}>
            <input className="input mono" value={form.toolPattern} onChange={(e) => setForm({ ...form, toolPattern: e.target.value })} aria-label={t('common.tools')} />
          </Field>
          <Field label={t('common.priority')}>
            <input className="input" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} aria-label={t('common.priority')} />
          </Field>
          <Field label={t('common.description')}>
            <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} aria-label={t('common.description')} />
          </Field>
        </div>
        <Field label={t('common.conditions')} hint={CONDITIONS_EXAMPLE}>
          <Editor value={form.conditions} onChange={(v) => setForm({ ...form, conditions: v })} height="160px" label={t('common.conditions')} />
        </Field>
        <ErrorBox error={save.error} />
        <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>
          {t('common.save')}
        </button>
      </div>
    </Drawer>
  );
}

export function Simulator({ defaultTool }: { defaultTool?: string }) {
  const t = useT();
  const tools = useTenantQuery<Page<Tool>>(['tools', 'all'], '/tools?limit=500');
  const [tool, setTool] = useState(defaultTool ?? '');
  const [roles, setRoles] = useState('agent');
  const [groups, setGroups] = useState('');
  const [clientId, setClientId] = useState('');
  const [claims, setClaims] = useState('{}');
  const [args, setArgs] = useState('');
  const sim = useMutation({
    mutationFn: () => {
      const c = parseJson<Record<string, unknown>>(claims);
      const a = args.trim() ? parseJson<Record<string, unknown>>(args) : { value: undefined };
      if (c.error || a.error) throw new Error(t('common.invalidJson', { error: c.error ?? a.error }));
      return api<Decision>('/policies/simulate', {
        method: 'POST',
        body: {
          subject: { roles: roles.split(',').map((r) => r.trim()).filter(Boolean), groups: groups.split(',').map((g) => g.trim()).filter(Boolean), ...(clientId ? { clientId } : {}), claims: c.value },
          tool: tool || tools.data?.items[0]?.name,
          ...(a.value ? { args: a.value } : {}),
          mode: a.value ? 'call' : 'list',
        },
      });
    },
  });
  const d = sim.data;
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="panel">
        <div className="panel-body">
          <Field label={t('common.tool')}>
            <select className="select mono" value={tool} onChange={(e) => setTool(e.target.value)} aria-label={t('policies.simulatedTool')}>
              {(tools.data?.items ?? []).map((tl) => (
                <option key={tl.id} value={tl.name}>
                  {tl.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid-2">
            <Field label={t('common.roles')}>
              <input className="input mono" value={roles} onChange={(e) => setRoles(e.target.value)} aria-label={t('common.roles')} />
            </Field>
            <Field label={t('common.groups')}>
              <input className="input mono" value={groups} onChange={(e) => setGroups(e.target.value)} aria-label={t('common.groups')} />
            </Field>
          </div>
          <Field label={t('common.clientId')}>
            <input className="input mono" value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label={t('common.clientId')} />
          </Field>
          <Field label={t('common.claimsJson')}>
            <Editor value={claims} onChange={setClaims} height="90px" label={t('common.claimsJson')} />
          </Field>
          <Field label={t('policies.argsField')}>
            <Editor value={args} onChange={setArgs} height="90px" label={t('policies.argsField')} />
          </Field>
          <button className="btn primary" onClick={() => sim.mutate()} disabled={sim.isPending}>
            {t('common.simulate')}
          </button>
        </div>
      </div>
      <div className="stack">
        <ErrorBox error={sim.error} />
        {d && (
          <>
            <div className={`alert ${d.effect === 'allow' ? 'ok' : 'error'}`} data-testid="decision">
              <strong>{d.effect === 'allow' ? t('common.allowed') : t('common.denied')}</strong> · <span className="mono">{d.reason}</span>
              <div style={{ marginTop: 6 }}>{d.explanation}</div>
            </div>
            {d.rule && (
              <div className="panel">
                <div className="panel-head">
                  <span className="panel-title">{t('policies.appliedRule')}</span>
                </div>
                <div className="panel-body mono">
                  <Badge kind={d.rule.effect}>{enumLabel(t, EFFECT_LABEL, d.rule.effect)}</Badge> {d.rule.subjectType}:{d.rule.subject} → {d.rule.toolPattern}
                </div>
              </div>
            )}
            <table className="table">
              <thead>
                <tr>
                  <th>{t('policies.evaluatedRule')}</th>
                  <th>{t('common.effect')}</th>
                  <th>{t('policies.matched')}</th>
                  <th>{t('policies.note')}</th>
                </tr>
              </thead>
              <tbody>
                {d.trace.map((r) => (
                  <tr key={r.ruleId}>
                    <td className="mono dim">{r.ruleId.slice(0, 8)}</td>
                    <td>
                      <Badge kind={r.effect}>{enumLabel(t, EFFECT_LABEL, r.effect)}</Badge>
                    </td>
                    <td>{r.matched ? t('common.yes') : t('common.no')}</td>
                    <td className="muted">{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
