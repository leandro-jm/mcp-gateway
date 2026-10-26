import { useState, type FormEvent } from 'react';
import { Field } from '../components/ui';
import { getLocale, useT } from '../i18n';

/**
 * First run (ADR-024): the setup screen (instance without users) and the first-tenant form
 * (platform admin without tenants, e.g. created with `create-admin`).
 */

export interface SetupStatus {
  needed: boolean;
  enabled: boolean;
}

export interface SetupResult {
  token: string;
  expiresAt: string;
  tenant: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** "Minha Empresa Ltda." → "minha-empresa-ltda" (same rule as the API). */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}

/** Setup status; `null` when the gateway does not support it or cannot be reached (falls back to the login). */
export async function fetchSetupStatus(): Promise<SetupStatus | null> {
  try {
    const res = await fetch('/admin/v1/setup', { headers: { accept: 'application/json' } });
    return res.ok ? ((await res.json()) as SetupStatus) : null;
  } catch {
    return null;
  }
}

function useTenantFields() {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  return {
    name,
    slug,
    valid: name.trim().length > 0 && SLUG_RE.test(slug),
    setName(v: string) {
      setName(v);
      if (!slugEdited) setSlug(slugify(v));
    },
    setSlug(v: string) {
      setSlugEdited(true);
      setSlug(v.toLowerCase());
    },
  };
}

function TenantFields({ tenant }: { tenant: ReturnType<typeof useTenantFields> }) {
  const t = useT();
  return (
    <>
      <Field label={t('auth.setupTenantName')}>
        <input id="tenant-name" className="input" value={tenant.name} onChange={(e) => tenant.setName(e.target.value)} />
      </Field>
      <Field label={t('auth.setupTenantSlug')} hint={t('auth.setupTenantSlugHint')}>
        <input id="tenant-slug" className="input mono" value={tenant.slug} onChange={(e) => tenant.setSlug(e.target.value)} />
      </Field>
    </>
  );
}

function Logo() {
  return (
    <div className="logo">
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M16 3 28 9.5v13L16 29 4 22.5v-13z" fill="none" stroke="currentColor" strokeWidth="2.6" />
        <path d="M4 9.5 16 16l12-6.5M16 16v13" fill="none" stroke="currentColor" strokeWidth="2.6" />
      </svg>
      <span>MCP Gateway</span>
    </div>
  );
}

export function SetupPage({ status, onDone }: { status: SetupStatus; onDone(r: SetupResult): void }) {
  const t = useT();
  const tenant = useTenantFields();
  const [setupToken, setSetupToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const passwordError = password && password.length < 8 ? t('auth.passwordTooShort') : confirm && confirm !== password ? t('auth.passwordMismatch') : null;
  const ready = Boolean(setupToken && username && password.length >= 8 && confirm === password && tenant.valid);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/admin/v1/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept-language': getLocale() },
        body: JSON.stringify({ setupToken, username, password, locale: getLocale(), tenant: { slug: tenant.slug, name: tenant.name.trim() } }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<SetupResult> & { message?: string };
      if (!res.ok || !body.token || !body.expiresAt || !body.tenant) throw new Error(body.message ?? t('auth.setupFailed', { status: res.status }));
      onDone({ token: body.token, expiresAt: body.expiresAt, tenant: body.tenant });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  if (!status.enabled) {
    return (
      <div className="login">
        <div className="panel login-card wide">
          <div className="panel-head">
            <Logo />
            <span className="panel-title">{t('auth.setupDisabledTitle')}</span>
          </div>
          <div className="panel-body">
            <p className="hint">{t('auth.setupDisabledBody', { command: 'node dist/migrate.js create-admin <username>' })}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login">
      <form className="panel login-card wide" onSubmit={(e) => void submit(e)}>
        <div className="panel-head">
          <Logo />
          <span className="panel-title">{t('auth.setupTitle')}</span>
        </div>
        <div className="panel-body">
          <p className="hint" style={{ marginTop: 0 }}>{t('auth.setupIntro')}</p>
          <Field label={t('auth.setupToken')} hint={t('auth.setupTokenHint')}>
            <input id="setup-token" className="input mono" type="password" autoComplete="off" autoFocus value={setupToken} onChange={(e) => setSetupToken(e.target.value)} />
          </Field>

          <div className="setup-section">{t('auth.setupTenantSection')}</div>
          <TenantFields tenant={tenant} />

          <div className="setup-section">{t('auth.setupAdminSection')}</div>
          <Field label={t('auth.username')}>
            <input id="username" className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </Field>
          <div className="grid-2">
            <Field label={t('auth.password')}>
              <input id="password" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label={t('auth.confirmPassword')}>
              <input id="confirm-password" className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
          </div>
          {passwordError && <p className="hint" role="status" style={{ marginTop: -8 }}>{passwordError}</p>}

          {error && (
            <div className="alert error" role="alert" style={{ marginBottom: 16 }}>
              {error}
            </div>
          )}
          <button id="setup" className="btn primary login-submit" type="submit" disabled={pending || !ready}>
            {pending ? t('auth.setupSubmitting') : t('auth.setupSubmit')}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Platform admin without any tenant: create the first one right here instead of a dead end. */
export function FirstTenantPage({ onCreate }: { onCreate(slug: string, name: string): Promise<void> }) {
  const t = useT();
  const tenant = useTenantFields();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await onCreate(tenant.slug, tenant.name.trim());
    } catch (err) {
      setError((err as Error).message);
      setPending(false);
    }
  }

  return (
    <div className="login">
      <form className="panel login-card wide" onSubmit={(e) => void submit(e)}>
        <div className="panel-head">
          <Logo />
          <span className="panel-title">{t('auth.firstTenantTitle')}</span>
        </div>
        <div className="panel-body">
          <p className="hint" style={{ marginTop: 0 }}>{t('auth.firstTenantIntro')}</p>
          <TenantFields tenant={tenant} />
          {error && (
            <div className="alert error" role="alert" style={{ marginBottom: 16 }}>
              {error}
            </div>
          )}
          <button id="create-tenant" className="btn primary login-submit" type="submit" disabled={pending || !tenant.valid}>
            {t('auth.firstTenantSubmit')}
          </button>
        </div>
      </form>
    </div>
  );
}
