import { createContext, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { getLocale, useT } from '../i18n';
import { fetchSetupStatus, SetupPage, type SetupStatus } from './setup';

/**
 * Admin UI session (ADR-011): username/password login against the Admin API, which returns an
 * opaque session token. The token lives in `sessionStorage` (gone when the tab is closed).
 */
const STORAGE_KEY = 'mcp-gw:session';
/** Tenant selected in the UI (same key as the session provider). */
const TENANT_KEY = 'mcp-gw:tenant';

interface StoredSession {
  token: string;
  expiresAt: string;
}

function readSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const s = raw ? (JSON.parse(raw) as StoredSession) : null;
    return s && new Date(s.expiresAt).getTime() > Date.now() ? s : null;
  } catch {
    return null;
  }
}

function writeSession(s: StoredSession | null): void {
  try {
    if (s) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable: the session only lasts for this page */
  }
}

/** Current token (read by the API client). */
export function getToken(): string | null {
  return readSession()?.token ?? null;
}

/** Expired or revoked session: discard it and reload into the login screen. */
export function endSession(): void {
  writeSession(null);
  window.location.assign(window.location.pathname);
}

interface AuthState {
  token: string | null;
  logout(): void;
}

const AuthContext = createContext<AuthState>({ token: null, logout: () => undefined });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(getToken);
  // first run (ADR-024): an instance without users shows the setup instead of the login
  const [setup, setSetup] = useState<SetupStatus | null | undefined>(undefined);
  useEffect(() => {
    if (token || setup !== undefined) return;
    void fetchSetupStatus().then(setSetup);
  }, [token, setup]);

  const value = useMemo<AuthState>(
    () => ({
      token,
      logout: () => {
        const current = getToken();
        const done = () => {
          writeSession(null);
          window.location.assign('/');
        };
        if (!current) return done();
        void fetch('/admin/v1/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${current}` } }).finally(done);
      },
    }),
    [token],
  );

  if (!token && setup === undefined) return null;
  if (!token && setup?.needed) {
    return (
      <SetupPage
        status={setup}
        onDone={(r) => {
          try {
            localStorage.setItem(TENANT_KEY, r.tenant);
          } catch {
            /* storage unavailable: the session picks the first tenant */
          }
          writeSession({ token: r.token, expiresAt: r.expiresAt });
          setToken(r.token);
        }}
      />
    );
  }
  if (!token) {
    return (
      <LoginPage
        onLogin={(s) => {
          writeSession(s);
          setToken(s.token);
        }}
      />
    );
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

function LoginPage({ onLogin }: { onLogin(s: StoredSession): void }) {
  const t = useT();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/admin/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept-language': getLocale() },
        body: JSON.stringify({ username, password }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<StoredSession> & { message?: string };
      if (!res.ok || !body.token || !body.expiresAt) throw new Error(body.message ?? t('auth.loginFailed', { status: res.status }));
      onLogin({ token: body.token, expiresAt: body.expiresAt });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="login">
      <form className="panel login-card" onSubmit={(e) => void submit(e)}>
        <div className="panel-head">
          <div className="logo">
            <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
              <path d="M16 3 28 9.5v13L16 29 4 22.5v-13z" fill="none" stroke="currentColor" strokeWidth="2.6" />
              <path d="M4 9.5 16 16l12-6.5M16 16v13" fill="none" stroke="currentColor" strokeWidth="2.6" />
            </svg>
            <span>MCP·GW</span>
          </div>
          <span className="panel-title">{t('auth.signIn')}</span>
        </div>
        <div className="panel-body">
          <div className="field">
            <label htmlFor="username">{t('auth.username')}</label>
            <input id="username" className="input" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="password">{t('auth.password')}</label>
            <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && (
            <div className="alert error" role="alert" style={{ marginBottom: 16 }}>
              {error}
            </div>
          )}
          <button id="login" className="btn primary login-submit" type="submit" disabled={pending || !username || !password}>
            {pending ? t('auth.signingIn') : t('auth.signIn')}
          </button>
        </div>
      </form>
    </div>
  );
}
