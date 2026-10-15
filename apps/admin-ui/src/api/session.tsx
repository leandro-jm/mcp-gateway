import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { FirstTenantPage } from '../auth/setup';
import { api, setApiTenant } from './client';
import type { Me, Page, Tenant } from './types';

interface SessionState {
  me: Me;
  tenant: string | null;
  tenants: Tenant[];
  setTenant(slug: string): void;
}

const SessionContext = createContext<SessionState | null>(null);
const STORAGE_KEY = 'mcp-gw:tenant';

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Logged-in user and selected tenant (gateway-admin can switch; an owner stays in their own tenant). */
export function SessionProvider({ children }: { children: ReactNode }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me', { tenant: null }) });
  const tenants = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api<Page<Tenant>>('/tenants?limit=500', { tenant: null }),
    enabled: Boolean(me.data?.isAdmin),
  });
  const [tenant, setTenantState] = useState<string | null>(null);
  const { locale, setLocale, t } = useI18n();
  const qc = useQueryClient();

  // the profile is the source of truth for the language (ADR-012)
  useEffect(() => {
    if (me.data && me.data.locale !== locale) setLocale(me.data.locale);
  }, [me.data?.locale]);

  useEffect(() => {
    if (!me.data) return;
    const initial = me.data.isAdmin ? (readStored() ?? me.data.tenant ?? tenants.data?.items[0]?.slug ?? null) : me.data.tenant;
    setTenantState(initial);
    setApiTenant(initial);
  }, [me.data, tenants.data]);

  if (me.isError) return <div className="content"><div className="alert error">{t('auth.noAdminAccess', { error: (me.error as Error).message })}</div></div>;
  if (me.data?.isAdmin && !me.data.tenant && tenants.data?.items.length === 0) {
    return (
      <FirstTenantPage
        onCreate={async (slug, name) => {
          await api<Tenant>('/tenants', { method: 'POST', tenant: null, body: { slug, name } });
          try {
            localStorage.setItem(STORAGE_KEY, slug);
          } catch {
            /* storage unavailable */
          }
          await qc.invalidateQueries({ queryKey: ['tenants'] });
        }}
      />
    );
  }
  if (!me.data || tenant === null) return <div className="loading content">{t('auth.loadingSession')}</div>;

  const value: SessionState = {
    me: me.data,
    tenant,
    tenants: tenants.data?.items ?? [],
    setTenant(slug) {
      try {
        localStorage.setItem(STORAGE_KEY, slug);
      } catch {
        /* storage unavailable */
      }
      setApiTenant(slug);
      setTenantState(slug);
    },
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside of SessionProvider');
  return s;
}
