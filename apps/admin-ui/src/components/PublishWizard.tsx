import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import type { CompositeReadiness, VirtualServer } from '../api/types';
import { useT, type UiMessageKey } from '../i18n';
import { useInvalidate, useTenantQuery } from '../lib/hooks';
import { enumLabel, TOOL_STATE_LABEL } from '../lib/labels';
import { useToast } from './toast';
import { Badge, Drawer, ErrorBox, Field } from './ui';

type Step = 'enable' | 'access' | 'server' | 'summary';
const STEPS: Array<[Step, UiMessageKey]> = [
  ['enable', 'composer.pubStepEnable'],
  ['access', 'composer.pubStepAccess'],
  ['server', 'composer.pubStepServer'],
  ['summary', 'composer.pubStepSummary'],
];
/** Denials an exact-name allow fixes; an explicit deny or unmet condition needs a human decision. */
const FIXABLE = new Set(['default_deny', 'destructive_requires_explicit_allow']);

/**
 * Publish assistant (F14.9): enable the composite and its steps, grant access per role and add it
 * to an MCP server. Every change is an explicit action of the user (ADR-015).
 */
export function PublishWizard({ compositeId, onClose }: { compositeId: string; onClose(): void }) {
  const t = useT();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [step, setStep] = useState<Step>('enable');
  const [rolesText, setRolesText] = useState('agent');
  const roles = rolesText
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
    .join(',');
  const readiness = useTenantQuery<CompositeReadiness>(['composites', compositeId, 'readiness', roles], `/composites/${compositeId}/readiness?roles=${encodeURIComponent(roles || 'agent')}`);
  const r = readiness.data;
  const refresh = () => {
    void readiness.refetch();
    void invalidate('tools');
    void invalidate('composites');
  };

  const enable = useMutation({
    mutationFn: (toolId: string) => api(`/tools/${toolId}/enable`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const missing = (r?.access ?? []).filter((a) => a.effect === 'deny' && FIXABLE.has(a.reason));
  const grant = useMutation({
    mutationFn: async () => {
      for (const a of missing) {
        await api('/policies', {
          method: 'POST',
          body: { subjectType: 'role', subject: a.role, effect: 'allow', toolPattern: a.tool, description: `composer: ${r!.composite.name}` },
        });
      }
      return missing.length;
    },
    onSuccess: (count) => {
      toast('ok', t('composer.pubPoliciesCreated', { count }));
      void invalidate('policies');
      refresh();
    },
  });
  const addToServer = useMutation({
    mutationFn: async (id: string) => {
      const vs = await api<VirtualServer>(`/virtual-servers/${id}`);
      const tools = [...new Set([...(vs.toolSelector.tools ?? []), r!.composite.name])];
      await api(`/virtual-servers/${id}`, { method: 'PATCH', body: { toolSelector: { ...vs.toolSelector, tools } } });
      return vs;
    },
    onSuccess: (vs) => {
      toast('ok', t('composer.pubAdded', { slug: vs.slug }));
      void invalidate('virtual-servers');
      refresh();
    },
  });
  const servers = useTenantQuery<{ items: VirtualServer[] }>(['virtual-servers'], '/virtual-servers');
  const endpointOf = (id: string) => servers.data?.items.find((s) => s.id === id)?.endpoints.mcp;

  const idx = STEPS.findIndex(([s]) => s === step);
  const stateBadge = (state: string | null) => <Badge kind={state === 'enabled' ? 'enabled' : 'disabled'}>{state ? enumLabel(t, TOOL_STATE_LABEL, state) : '—'}</Badge>;

  return (
    <Drawer title={t('composer.pubTitle', { name: r?.composite.name ?? '' })} onClose={onClose}>
      <div className="stepper" role="tablist">
        {STEPS.map(([s, label], i) => (
          <button key={s} role="tab" aria-selected={s === step} className={s === step ? 'active' : ''} onClick={() => setStep(s)}>
            {i + 1}. {t(label)}
          </button>
        ))}
      </div>
      <div className="drawer-body stack" data-testid="publish-wizard">
        <ErrorBox error={readiness.error ?? enable.error ?? grant.error ?? addToServer.error} />
        {r && step === 'enable' && (
          <>
            <p className="hint">{t('composer.pubEnableIntro')}</p>
            {r.composite.status !== 'valid' && <div className="alert error">{t('composer.pubInvalid')}</div>}
            <table className="table">
              <tbody>
                <tr>
                  <td className="mono">
                    {r.composite.name} <span className="hint">({t('composer.pubComposite')})</span>
                  </td>
                  <td>{stateBadge(r.composite.state)}</td>
                  <td>
                    {r.composite.state !== 'enabled' && (
                      <button className="btn sm primary" disabled={r.composite.status !== 'valid' || enable.isPending} onClick={() => enable.mutate(r.composite.toolId)}>
                        {t('composer.pubEnable')}
                      </button>
                    )}
                  </td>
                </tr>
                {r.steps.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">
                      {s.id} → {s.tool}
                    </td>
                    <td>{stateBadge(s.state)}</td>
                    <td>
                      {s.toolId && s.state !== 'enabled' &&
                        (s.canManage ? (
                          <button className="btn sm" disabled={enable.isPending} onClick={() => enable.mutate(s.toolId!)}>
                            {t('composer.pubEnable')}
                          </button>
                        ) : (
                          <span className="hint">{t('composer.pubNoPermission')}</span>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {r && step === 'access' && (
          <>
            <p className="hint">{t('composer.pubAccessIntro')}</p>
            <Field label={t('composer.pubRoles')}>
              <input className="input mono" aria-label={t('composer.pubRoles')} value={rolesText} onChange={(e) => setRolesText(e.target.value)} />
            </Field>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.tool')}</th>
                  <th>{t('composer.pubColRole')}</th>
                  <th>{t('common.effect')}</th>
                </tr>
              </thead>
              <tbody>
                {r.access.map((a) => (
                  <tr key={`${a.tool}|${a.role}`}>
                    <td className="mono">{a.tool}</td>
                    <td className="mono">{a.role}</td>
                    <td title={a.explanation}>
                      <Badge kind={a.effect === 'allow' ? 'ok' : 'error'}>{a.effect}</Badge> <span className="hint">{a.explanation}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {missing.length > 0 &&
              (r.canCreatePolicies ? (
                <button
                  className="btn primary"
                  disabled={grant.isPending}
                  onClick={() => confirm(t('composer.pubCreateConfirm', { list: missing.map((a) => `allow role:${a.role} → ${a.tool}`).join('\n') })) && grant.mutate()}
                >
                  {t('composer.pubCreatePolicies', { count: missing.length })}
                </button>
              ) : (
                <div className="alert warn">{t('composer.pubNeedsAdmin')}</div>
              ))}
          </>
        )}

        {r && step === 'server' && (
          <>
            <p className="hint">{t('composer.pubServerIntro')}</p>
            {r.virtualServers.length === 0 && <div className="alert warn">{t('composer.pubNoServers')}</div>}
            <table className="table">
              <tbody>
                {r.virtualServers.map((vs) => (
                  <tr key={vs.id}>
                    <td className="mono">{vs.slug}</td>
                    <td className="mono hint">{endpointOf(vs.id) ?? `/mcp/s/${vs.slug}`}</td>
                    <td>
                      {vs.includes ? (
                        <Badge kind="ok">{t('composer.pubIncluded')}</Badge>
                      ) : vs.canManage ? (
                        <button className="btn sm" disabled={addToServer.isPending} onClick={() => addToServer.mutate(vs.id)}>
                          {t('composer.pubAdd')}
                        </button>
                      ) : (
                        <span className="hint">{t('composer.pubNoPermission')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {r && step === 'summary' && (
          <div className={`alert ${r.ready ? 'ok' : 'warn'}`} data-testid="publish-summary">
            {r.ready ? t('composer.pubSummaryReady', { name: r.composite.name }) : t('composer.pubSummaryPending')}
          </div>
        )}

        <div className="row">
          {idx > 0 && (
            <button className="btn" onClick={() => setStep(STEPS[idx - 1]![0])}>
              {t('composer.pubBack')}
            </button>
          )}
          {idx < STEPS.length - 1 ? (
            <button className="btn primary" onClick={() => setStep(STEPS[idx + 1]![0])}>
              {t('composer.pubNext')}
            </button>
          ) : (
            <button className="btn primary" onClick={onClose}>
              {t('composer.pubDone')}
            </button>
          )}
        </div>
      </div>
    </Drawer>
  );
}
