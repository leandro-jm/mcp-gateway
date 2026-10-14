import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Box,
  Building2,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Database,
  EyeOff,
  FlaskConical,
  Folder,
  GitCompareArrows,
  Inbox,
  KeyRound,
  Lightbulb,
  ListTree,
  LogOut,
  Network,
  Rocket,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  User,
  Users,
  Waypoints,
  Workflow,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { useAuth } from '../auth/auth';
import { LanguageSelector } from './LanguageSelector';
import { ThemeSelector } from './ThemeSelector';
import { api } from '../api/client';
import { useSession } from '../api/session';
import type { DriftEvent, Page, Tool } from '../api/types';
import { useT, type UiMessageKey } from '../i18n';
import { enumLabel, TOOL_STATE_LABEL } from '../lib/labels';
import { useOnboarding } from '../lib/onboarding';

const NAV: Array<{ group?: UiMessageKey; items: Array<{ to: string; label: UiMessageKey; icon: ReactNode; adminOnly?: boolean; platformOnly?: boolean; analystOnly?: boolean }> }> = [
  {
    items: [
      { to: '/onboarding', label: 'shell.navOnboarding', icon: <Rocket size={22} /> },
      { to: '/tools', label: 'shell.navTools', icon: <Box size={22} /> },
      { to: '/sources', label: 'shell.navSources', icon: <Database size={22} /> },
      { to: '/servers', label: 'shell.navServers', icon: <Network size={22} /> },
      { to: '/playground', label: 'shell.navPlayground', icon: <FlaskConical size={22} /> },
    ],
  },
  {
    group: 'shell.navGroupConfigure',
    items: [
      { to: '/composer', label: 'shell.navComposer', icon: <Workflow size={22} /> },
      { to: '/policies', label: 'shell.navPolicies', icon: <ShieldCheck size={22} /> },
      { to: '/pii', label: 'shell.navPii', icon: <EyeOff size={22} /> },
      { to: '/projections', label: 'shell.navProjections', icon: <SlidersHorizontal size={22} /> },
    ],
  },
  {
    group: 'shell.navGroupManage',
    items: [
      { to: '/drift', label: 'shell.navDrift', icon: <GitCompareArrows size={22} /> },
      { to: '/observability', label: 'shell.navObservability', icon: <Activity size={22} /> },
      { to: '/calls', label: 'shell.navCalls', icon: <ListTree size={22} /> },
      { to: '/sessions', label: 'shell.navSessions', icon: <Waypoints size={22} />, analystOnly: true },
      { to: '/agents', label: 'shell.navAgents', icon: <Lightbulb size={22} /> },
      { to: '/audit', label: 'shell.navAudit', icon: <ScrollText size={22} /> },
      { to: '/tenants', label: 'shell.navTenants', icon: <Building2 size={22} />, platformOnly: true },
      { to: '/users', label: 'shell.navUsers', icon: <Users size={22} />, adminOnly: true },
      { to: '/tokens', label: 'shell.navTokens', icon: <KeyRound size={22} /> },
      { to: '/settings', label: 'shell.navSettings', icon: <Settings size={22} />, adminOnly: true },
    ],
  },
];

function Logo() {
  return (
    <div className="logo">
      <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M16 3 28 9.5v13L16 29 4 22.5v-13z" fill="none" stroke="currentColor" strokeWidth="2.6" />
        <path d="M4 9.5 16 16l12-6.5M16 16v13" fill="none" stroke="currentColor" strokeWidth="2.6" />
      </svg>
      <span>MCP·GW</span>
    </div>
  );
}

function CommandPalette({ onClose }: { onClose(): void }) {
  const t = useT();
  const navigate = useNavigate();
  const { tenant } = useSession();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const tools = useQuery({ queryKey: [tenant, 'tools', 'palette'], queryFn: () => api<Page<Tool>>('/tools?limit=500') });
  const items = useMemo(() => {
    const pages = NAV.flatMap((g) => g.items).map((i) => ({ key: i.to, label: t(i.label), hint: t('shell.paletteHintPage'), go: () => navigate(i.to) }));
    const ts = (tools.data?.items ?? []).map((tool) => ({
      key: tool.id,
      label: tool.name,
      hint: enumLabel(t, TOOL_STATE_LABEL, tool.state),
      go: () => navigate(`/tools?open=${tool.id}`),
    }));
    const all = [...pages, ...ts];
    const needle = q.toLowerCase();
    return (needle ? all.filter((i) => i.label.toLowerCase().includes(needle)) : all).slice(0, 30);
  }, [q, tools.data, navigate, t]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="palette" role="dialog" aria-label={t('shell.paletteLabel')}>
        <input
          autoFocus
          placeholder={t('shell.palettePlaceholder')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') setSel((s) => Math.min(s + 1, items.length - 1));
            if (e.key === 'ArrowUp') setSel((s) => Math.max(s - 1, 0));
            if (e.key === 'Enter' && items[sel]) {
              items[sel]!.go();
              onClose();
            }
          }}
        />
        <ul>
          {items.map((i, n) => (
            <li key={i.key}>
              <button
                className={n === sel ? 'sel' : ''}
                onClick={() => {
                  i.go();
                  onClose();
                }}
              >
                <span className="mono">{i.label}</span>
                <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
                  {i.hint}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const t = useT();
  const { me, tenant, tenants, setTenant } = useSession();
  const { logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [palette, setPalette] = useState(false);
  const navigate = useNavigate();
  const drift = useQuery({
    queryKey: [tenant, 'drift', 'pending'],
    queryFn: () => api<Page<DriftEvent>>('/drift-events?pending=true&limit=200'),
    refetchInterval: 30_000,
  });
  const pending = drift.data?.total ?? 0;
  const onboarding = useOnboarding();
  const onboardingLeft = onboarding.isLoading ? 0 : onboarding.total - onboarding.done;
  const env = import.meta.env.VITE_ENV_LABEL ?? 'DEV';
  const initials = (me.name ?? me.sub)
    .split(/[\s._-]+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''}`}>
      <header className="topbar">
        <Logo />
        <nav className="crumbs" aria-label={t('shell.context')}>
          {me.isAdmin && tenants.length > 1 ? (
            // the native select covers the whole crumb, so icon and chevron open it too
            <span className="crumb switchable">
              <User size={20} className="muted" />
              <span>{tenants.find((tn) => tn.slug === tenant)?.name ?? tenant}</span>
              <ChevronsUpDown size={16} className="muted" />
              <select value={tenant ?? ''} onChange={(e) => setTenant(e.target.value)} aria-label={t('shell.tenant')}>
                {tenants.map((tn) => (
                  <option key={tn.slug} value={tn.slug}>
                    {tn.name}
                  </option>
                ))}
              </select>
            </span>
          ) : (
            <span className="crumb">
              <User size={20} className="muted" />
              <span>{tenants.find((tn) => tn.slug === tenant)?.name ?? tenant}</span>
            </span>
          )}
          <span className="sep">/</span>
          <span className="crumb">
            <Folder size={20} className="muted" />
            <span>Gateway</span>
            <span className="env-badge">{env}</span>
          </span>
        </nav>
        <div className="spacer" />
        <button className="jump" onClick={() => setPalette(true)}>
          <Search size={20} />
          <span>{t('shell.jumpTo')}</span>
          <kbd>⌘ K</kbd>
        </button>
        <LanguageSelector />
        <ThemeSelector />
        <button className="icon-btn" title={t('shell.driftPending')} aria-label={t('shell.driftPending')} onClick={() => navigate('/drift')}>
          <Inbox size={20} />
          {pending > 0 && <span className="dot" />}
        </button>
        <button className="avatar" title={t('shell.signOutAs', { name: me.name ?? me.sub })} onClick={logout}>
          {initials}
        </button>
      </header>
      <aside className="sidebar">
        {NAV.map((g, i) => (
          <div key={i}>
            {g.group && <div className="nav-group">{t(g.group)}</div>}
            {g.items.filter((item) => (!item.adminOnly || me.isAdmin) && (!item.platformOnly || (me.isAdmin && me.tenant === null)) && (!item.analystOnly || me.isAdmin || me.roles.includes('analytics-reader'))).map((item) => (
              <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                {item.icon}
                <span>{t(item.label)}</span>
                {item.to === '/drift' && pending > 0 && <span className="count">{pending}</span>}
                {item.to === '/onboarding' && onboardingLeft > 0 && <span className="count">{onboardingLeft}</span>}
              </NavLink>
            ))}
          </div>
        ))}
        <div className="grow" />
        <button className="nav-item" style={{ background: 'none', cursor: 'pointer' }} onClick={logout}>
          <LogOut size={20} />
          <span>{t('shell.signOut')}</span>
        </button>
        <button className="collapse-btn" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? t('shell.expandMenu') : t('shell.collapseMenu')}>
          {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
      </aside>
      <main className="main">{children}</main>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  );
}
