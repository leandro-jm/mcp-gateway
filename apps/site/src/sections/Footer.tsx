import { ArrowUp, BookOpen } from 'lucide-react';
import { CubeArt } from '../components/CubeArt';
import { GithubIcon } from '../components/GithubIcon';
import { Logo } from '../components/Logo';
import { Reveal } from '../components/Reveal';
import type { SiteMessageKey } from '../i18n/catalog';
import { useT } from '../i18n/I18nProvider';
import { AUTHOR, REPO_URL, VERSION, repoFile, repoTree } from '../lib/links';
import { trackPointer } from '../lib/motion';

const PROJECT: Array<{ label: SiteMessageKey; href: string }> = [
  { label: 'footer.docs', href: repoTree('docs') },
  { label: 'footer.changelog', href: repoFile('CHANGELOG.md') },
  { label: 'footer.roadmap', href: repoFile('docs/roadmap.md') },
  { label: 'footer.decisions', href: repoTree('docs/decisions') },
];

const COMMUNITY: Array<{ label: SiteMessageKey; href: string }> = [
  { label: 'footer.contributing', href: repoFile('CONTRIBUTING.md') },
  { label: 'footer.conduct', href: repoFile('CODE_OF_CONDUCT.md') },
  { label: 'footer.security', href: repoFile('SECURITY.md') },
  { label: 'footer.issues', href: `${REPO_URL}/issues` },
];

export function Footer() {
  const t = useT();
  return (
    <footer className="footer">
      <section className="cta" onPointerMove={trackPointer}>
        <div className="cta-glow" aria-hidden="true" />
        <div className="container cta-inner">
          <Reveal className="cta-copy">
            <h2>{t('footer.ctaTitle')}</h2>
            <p>{t('footer.ctaLead')}</p>
            <div className="hero-ctas">
              <a className="btn btn-primary" href={REPO_URL} target="_blank" rel="noreferrer">
                <GithubIcon size={17} />
                {t('footer.ctaStar')}
              </a>
              <a className="btn" href={repoTree('docs')} target="_blank" rel="noreferrer">
                <BookOpen size={17} />
                {t('footer.ctaDocs')}
              </a>
            </div>
          </Reveal>
          <div className="cta-art" aria-hidden="true">
            <CubeArt size={220} />
          </div>
        </div>
      </section>
      <div className="container footer-grid">
        <div className="footer-brand">
          <Logo />
          <p className="mono-label">v{VERSION} · Apache-2.0</p>
          <p className="footer-small">
            {t('footer.by', { name: AUTHOR.name })}{' '}
            <a href={AUTHOR.url} target="_blank" rel="noreferrer">
              @leandro-jm
            </a>
          </p>
        </div>
        <nav aria-label={t('footer.project')}>
          <h3 className="mono-label">{t('footer.project')}</h3>
          {PROJECT.map((l) => (
            <a key={l.label} href={l.href} target="_blank" rel="noreferrer">
              {t(l.label)}
            </a>
          ))}
        </nav>
        <nav aria-label={t('footer.community')}>
          <h3 className="mono-label">{t('footer.community')}</h3>
          {COMMUNITY.map((l) => (
            <a key={l.label} href={l.href} target="_blank" rel="noreferrer">
              {t(l.label)}
            </a>
          ))}
        </nav>
      </div>
      <div className="footer-bottom-wrap">
        <div className="container footer-bottom">
          <span>
            {t('footer.license')} {t('footer.fonts')}
          </span>
          <a href="#top" className="to-top">
            {t('footer.top')}
            <ArrowUp size={14} />
          </a>
        </div>
      </div>
    </footer>
  );
}
