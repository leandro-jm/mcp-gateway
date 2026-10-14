import { ArrowRight } from 'lucide-react';
import { GithubIcon } from '../components/GithubIcon';
import { CubeArt } from '../components/CubeArt';
import { DecodeText } from '../components/DecodeText';
import { Terminal } from '../components/Terminal';
import { useT } from '../i18n/I18nProvider';
import { REPO_URL, VERSION } from '../lib/links';
import { trackPointer } from '../lib/motion';

const INPUTS = ['openapi.yaml', 'swagger.json', 'postman.json', 'session.har', 'curl -X GET …'];
const OUTPUTS = ['rh_colaborador_get', 'rh_escalas_list', 'search_tools', 'call_tool'];
const SPEAKS = ['OpenAPI 3.x', 'Swagger 2.0', 'Postman', 'HAR', 'cURL', 'MCP 2025-11-25', 'Claude Code', 'OpenAI-compatible', 'OAuth2', 'JSONata', 'OpenTelemetry', 'Prometheus', 'Grafana', 'Postgres', 'Redis', 'S3 / MinIO', 'Docker'];

export function Hero() {
  const t = useT();
  return (
    <section className="hero" id="top" onPointerMove={trackPointer}>
      <div className="hero-grid" aria-hidden="true" />
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
        <div className="hero-art" aria-hidden="true">
          <div className="chips chips-in">
            <span className="mono-label">{t('hero.inputs')}</span>
            {INPUTS.map((c, i) => (
              <span key={c} className="chip" style={{ animationDelay: `${i * 0.6}s` }}>
                {c}
              </span>
            ))}
          </div>
          <CubeArt size={340} />
          <div className="chips chips-out">
            <span className="mono-label">{t('hero.outputs')}</span>
            {OUTPUTS.map((c, i) => (
              <span key={c} className="chip chip-accent" style={{ animationDelay: `${0.3 + i * 0.6}s` }}>
                {c}
              </span>
            ))}
          </div>
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
