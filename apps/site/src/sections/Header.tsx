import { LOCALES, LOCALE_NAMES, type Locale } from '@mcp-gateway/i18n';
import { Menu, Monitor, Moon, Sun, X } from 'lucide-react';
import { GithubIcon } from '../components/GithubIcon';
import { useEffect, useState } from 'react';
import { Logo } from '../components/Logo';
import type { SiteMessageKey } from '../i18n/catalog';
import { useI18n } from '../i18n/I18nProvider';
import { REPO_URL } from '../lib/links';
import { useTheme, type ThemePref } from '../theme/theme';

const LINKS: Array<{ href: string; label: SiteMessageKey }> = [
  { href: '#why', label: 'nav.why' },
  { href: '#how', label: 'nav.how' },
  { href: '#features', label: 'nav.features' },
  { href: '#endpoints', label: 'nav.endpoints' },
  { href: '#quickstart', label: 'nav.quickstart' },
];

const SHORT: Record<Locale, string> = { en: 'EN', 'pt-BR': 'PT', es: 'ES' };
const NEXT_THEME: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_LABEL: Record<ThemePref, SiteMessageKey> = { system: 'nav.themeSystem', light: 'nav.themeLight', dark: 'nav.themeDark' };

export function Header() {
  const { locale, setLocale, t } = useI18n();
  const { pref, setPref } = useTheme();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        document.documentElement.style.setProperty('--scroll', String(max > 0 ? window.scrollY / max : 0));
        setScrolled(window.scrollY > 8);
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const ThemeIcon = pref === 'system' ? Monitor : pref === 'light' ? Sun : Moon;
  const themeLabel = t('nav.theme', { name: t(THEME_LABEL[pref]) });

  return (
    <header className={`header ${scrolled ? 'is-scrolled' : ''} ${open ? 'is-open' : ''}`}>
      <div className="scroll-progress" aria-hidden="true" />
      <div className="container header-inner">
        <a href="#top" className="header-logo" aria-label={t('nav.home')}>
          <Logo />
        </a>
        <nav className="header-nav" id="site-nav" aria-label={t('nav.primary')}>
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} onClick={() => setOpen(false)}>
              {t(l.label)}
            </a>
          ))}
        </nav>
        <div className="header-tools">
          <div className="lang-switch" role="group" aria-label={t('nav.language')}>
            {LOCALES.map((l) => (
              <button key={l} type="button" lang={l} className={l === locale ? 'is-active' : ''} aria-pressed={l === locale} title={LOCALE_NAMES[l]} onClick={() => setLocale(l)}>
                {SHORT[l]}
              </button>
            ))}
          </div>
          <button type="button" className="icon-btn" onClick={() => setPref(NEXT_THEME[pref])} aria-label={themeLabel} title={themeLabel}>
            <ThemeIcon size={17} />
          </button>
          <a className="btn btn-primary btn-sm header-gh" href={REPO_URL} target="_blank" rel="noreferrer">
            <GithubIcon size={16} />
            <span>{t('nav.github')}</span>
          </a>
          <button type="button" className="icon-btn header-menu" aria-expanded={open} aria-controls="site-nav" aria-label={t('nav.menu')} onClick={() => setOpen((o) => !o)}>
            {open ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </div>
    </header>
  );
}
