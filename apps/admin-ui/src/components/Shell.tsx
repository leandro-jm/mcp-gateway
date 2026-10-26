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
  Users,
  Waypoints,
  Workflow,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/auth';
import { LanguageSelector } from './LanguageSelector';
import { ThemeSelector } from './ThemeSelector';
import { api } from '../api/client';
import { useSession } from '../api/session';
import type { DriftEvent, Page, Tool } from '../api/types';
import { useT, type UiMessageKey } from '../i18n';
import { enumLabel, TOOL_STATE_LABEL } from '../lib/labels';
import { useOnboarding } from '../lib/onboarding';

interface NavItem {
  to: string;
  label: UiMessageKey;
  icon: ReactNode;
  adminOnly?: boolean;
  platformOnly?: boolean;
  analystOnly?: boolean;
}

const NAV: Array<{ group: UiMessageKey; items: NavItem[] }> = [
  {
    group: 'shell.navGroupOperate',
    items: [
      { to: '/onboarding', label: 'shell.navOnboarding', icon: <Rocket size={18} strokeWidth={1.8} /> },
      { to: '/tools', label: 'shell.navTools', icon: <Box size={18} strokeWidth={1.8} /> },
      { to: '/sources', label: 'shell.navSources', icon: <Database size={18} strokeWidth={1.8} /> },
      { to: '/servers', label: 'shell.navServers', icon: <Network size={18} strokeWidth={1.8} /> },
      { to: '/playground', label: 'shell.navPlayground', icon: <FlaskConical size={18} strokeWidth={1.8} /> },
    ],
  },
  {
    group: 'shell.navGroupConfigure',
    items: [
      { to: '/composer', label: 'shell.navComposer', icon: <Workflow size={18} strokeWidth={1.8} /> },
      { to: '/policies', label: 'shell.navPolicies', icon: <ShieldCheck size={18} strokeWidth={1.8} /> },
      { to: '/pii', label: 'shell.navPii', icon: <EyeOff size={18} strokeWidth={1.8} /> },
      { to: '/projections', label: 'shell.navProjections', icon: <SlidersHorizontal size={18} strokeWidth={1.8} /> },
    ],
  },
  {
    group: 'shell.navGroupManage',
    items: [
      { to: '/drift', label: 'shell.navDrift', icon: <GitCompareArrows size={18} strokeWidth={1.8} /> },
      { to: '/observability', label: 'shell.navObservability', icon: <Activity size={18} strokeWidth={1.8} /> },
      { to: '/calls', label: 'shell.navCalls', icon: <ListTree size={18} strokeWidth={1.8} /> },
      { to: '/sessions', label: 'shell.navSessions', icon: <Waypoints size={18} strokeWidth={1.8} />, analystOnly: true },
      { to: '/agents', label: 'shell.navAgents', icon: <Lightbulb size={18} strokeWidth={1.8} /> },
      { to: '/audit', label: 'shell.navAudit', icon: <ScrollText size={18} strokeWidth={1.8} /> },
      { to: '/tenants', label: 'shell.navTenants', icon: <Building2 size={18} strokeWidth={1.8} />, platformOnly: true },
      { to: '/users', label: 'shell.navUsers', icon: <Users size={18} strokeWidth={1.8} />, adminOnly: true },
      { to: '/tokens', label: 'shell.navTokens', icon: <KeyRound size={18} strokeWidth={1.8} /> },
      { to: '/settings', label: 'shell.navSettings', icon: <Settings size={18} strokeWidth={1.8} />, adminOnly: true },
    ],
  },
];

function Brand() {
  const t = useT();
  return (
    <div className="brand">
      <span className="brand-mark">
        <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true">
          <path d="M16 3 28 9.5v13L16 29 4 22.5v-13z" fill="none" stroke="currentColor" strokeWidth="2.8" />
          <path d="M4 9.5 16 16l12-6.5M16 16v13" fill="none" stroke="currentColor" strokeWidth="2.8" />
        </svg>
      </span>
      <div className="brand-text">
        <b>MCP Gateway</b>
        <small>{t('shell.brandTagline')}</small>
      </div>
    </div>
  );
}

/** Avatar with name and role; opens a small menu with the signed-in identity and sign out. */
function UserMenu({ name, role, initials, onSignOut }: { name: string; role: string; initials: string; onSignOut(): void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menu-anchor user" ref={ref}>
      <button className="user-btn" aria-label={t('shell.account')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="avatar">{initials}</span>
        <span className="user-name">
          {name}
          <small>{role}</small>
        </span>
      </button>
      {open && (
        <div className="menu" role="menu" aria-label={t('shell.account')}>
          <div className="menu-label">{t('shell.signedInAs', { name })}</div>
          <button role="menuitem" className="menu-item" onClick={onSignOut}>
            <LogOut size={16} />
            <span>{t('shell.signOut')}</span>
          </button>
        </div>
      )}
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
  const displayName = me.name ?? me.sub;
  const role = me.isAdmin && me.tenant === null ? t('shell.rolePlatformAdmin') : (me.roles[0] ?? '');
  const tenantName = tenants.find((tn) => tn.slug === tenant)?.name ?? tenant;
  const { pathname } = useLocation();
  const visible = (item: NavItem) =>
    (!item.adminOnly || me.isAdmin) && (!item.platformOnly || (me.isAdmin && me.tenant === null)) && (!item.analystOnly || me.isAdmin || me.roles.includes('analytics-reader'));
  const current = NAV.flatMap((g) => g.items).find((i) => pathname === i.to || pathname.startsWith(`${i.to}/`));
  const initials = displayName
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
      <aside className="sidebar">
        <Brand />
        <nav className="nav" aria-label={t('shell.sections')}>
          {NAV.map((g) => (
            <div key={g.group} className="nav-section">
              <div className="nav-group">{t(g.group)}</div>
              {g.items.filter(visible).map((item) => (
                <NavLink key={item.to} to={item.to} title={collapsed ? t(item.label) : undefined} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                  {item.icon}
                  <span>{t(item.label)}</span>
                  {item.to === '/drift' && pending > 0 && <span className="count">{pending}</span>}
                  {item.to === '/onboarding' && onboardingLeft > 0 && <span className="count strong">{onboardingLeft}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <div className="side-env">
            <span>Gateway</span>
            <span className="env-badge">{env}</span>
          </div>
          <button className="nav-item" onClick={logout}>
            <LogOut size={18} strokeWidth={1.8} />
            <span>{t('shell.signOut')}</span>
          </button>
          <button className="collapse-btn" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? t('shell.expandMenu') : t('shell.collapseMenu')}>
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>
      </aside>
      <div className="shell-body">
        <header className="topbar">
          <nav className="crumbs" aria-label={t('shell.context')}>
            {me.isAdmin && tenants.length > 1 ? (
              // the native select covers the whole crumb, so the chevron opens it too
              <span className="crumb switchable">
                <span>{tenantName}</span>
                <ChevronsUpDown size={14} />
                <select value={tenant ?? ''} onChange={(e) => setTenant(e.target.value)} aria-label={t('shell.tenant')}>
                  {tenants.map((tn) => (
                    <option key={tn.slug} value={tn.slug}>
                      {tn.name}
                    </option>
                  ))}
                </select>
              </span>
            ) : (
              <span className="crumb">{tenantName}</span>
            )}
            {current && (
              <>
                <span className="sep">/</span>
                <b className="crumb-page">{t(current.label)}</b>
              </>
            )}
          </nav>
          <div className="spacer" />
          <button className="jump" onClick={() => setPalette(true)}>
            <Search size={16} />
            <span>{t('shell.jumpTo')}</span>
            <kbd>⌘K</kbd>
          </button>
          <LanguageSelector />
          <ThemeSelector />
          <button className="icon-btn" title={t('shell.driftPending')} aria-label={t('shell.driftPending')} onClick={() => navigate('/drift')}>
            <Inbox size={18} strokeWidth={1.8} />
            {pending > 0 && <span className="dot" />}
          </button>
          <UserMenu name={displayName} role={role} initials={initials} onSignOut={logout} />
        </header>
        <main className="main">{children}</main>
      </div>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  );
}
