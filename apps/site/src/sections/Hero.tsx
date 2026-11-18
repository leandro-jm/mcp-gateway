import { ArrowRight } from 'lucide-react';
import { GithubIcon } from '../components/GithubIcon';
import { ControlPlaneArt } from '../components/ControlPlaneArt';
import { DecodeText } from '../components/DecodeText';
import { Terminal } from '../components/Terminal';
import { useT } from '../i18n/I18nProvider';
import { REPO_URL, VERSION } from '../lib/links';
import { trackPointer } from '../lib/motion';

const SPEAKS = ['MCP 2026-07-28', 'MCP 2025-11-25', 'OAuth 2.1 + PKCE', 'Claude', 'ChatGPT', 'VS Code', 'MCP Apps', 'OpenAPI 3.x', 'Postman', 'HAR', 'cURL', 'JSONata', 'OpenTelemetry', 'Prometheus', 'Grafana', 'Postgres', 'Redis', 'S3 / MinIO', 'Docker'];

export function Hero() {
  const t = useT();
  return (
    <section className="hero" id="top" onPointerMove={trackPointer}>
      <div className="hero-grid" aria-hidden="true" />
      <div className="hero-beams" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="hero-glow" aria-hidden="true" />
      <div className="container hero-inner">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="live-dot" aria-hidden="true" />
            {t('hero.eyebrow', { version: VERSION })}
            <span className="eyebrow-sep">·</span>
            Apache-2.0
          </div>
          <h1 className="hero-title">
            <span className="hero-line">
              <DecodeText text={t('hero.titleA')} />
            </span>
            <span className="hero-line accent">
              <DecodeText text={t('hero.titleB')} delay={260} />
            </span>
          </h1>
          <p className="hero-lead">{t('hero.lead')}</p>
          <div className="hero-ctas">
            <a className="btn btn-primary" href="#quickstart">
              {t('hero.ctaStart')}
              <ArrowRight size={17} />
            </a>
            <a className="btn" href={REPO_URL} target="_blank" rel="noreferrer">
              <GithubIcon size={17} />
              {t('hero.ctaGithub')}
            </a>
          </div>
        </div>
        <div className="hero-art">
          <ControlPlaneArt />
        </div>
      </div>
      <div className="container hero-terminal">
        <Terminal />
        <p className="terminal-caption">{t('hero.termCaption')}</p>
      </div>
      <div className="marquee" aria-label={`${t('hero.speaks')}: ${SPEAKS.join(', ')}`}>
        <span className="marquee-label mono-label">{t('hero.speaks')}</span>
        <div className="marquee-track" aria-hidden="true">
          {[0, 1].map((copy) => (
            <div className="marquee-group" key={copy}>
              {SPEAKS.map((s) => (
                <span key={s}>{s}</span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
