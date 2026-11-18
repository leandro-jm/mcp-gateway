import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { CodeBlock } from '../components/CodeBlock';
import { Reveal } from '../components/Reveal';
import type { SiteMessageKey } from '../i18n/catalog';
import { useT } from '../i18n/I18nProvider';
import { SectionHead } from './SectionHead';

interface Step {
  label: SiteMessageKey;
  code?: string;
  lang?: string;
}

const RAW = 'https://raw.githubusercontent.com/leandro-jm/mcp-gateway/main/docker';
const DEV_TOKEN = 'mgw_dev-agent-token-somente-para-desenvolvimento';

/** Commands from docs/deploy.md (§4 and §7), README.md (Quickstart) and docs/integrations/claude-code.md. */
const TABS: Record<'docker' | 'local' | 'connect', { label: SiteMessageKey; steps: Step[] }> = {
  docker: {
    label: 'quickstart.tabDocker',
    steps: [
      { label: 'quickstart.dockerGet', code: `curl -fsSLO ${RAW}/docker-compose.prod.yml\ncurl -fsSL ${RAW}/prod.env.example -o .env` },
      { label: 'quickstart.dockerSecrets', code: 'openssl rand -hex 16   # paste it as SETUP_TOKEN in .env\nvi .env' },
      { label: 'quickstart.dockerUp', code: 'docker compose -f docker-compose.prod.yml --env-file .env up -d --wait' },
      { label: 'quickstart.dockerSetup' },
      { label: 'quickstart.dockerNote' },
    ],
  },
  local: {
    label: 'quickstart.tabLocal',
    steps: [
      { label: 'quickstart.localClone', code: 'git clone https://github.com/leandro-jm/mcp-gateway.git\ncd mcp-gateway\npnpm install' },
      { label: 'quickstart.localInfra', code: 'pnpm dev:infra   # Postgres :15432, Redis :16379, MinIO :19000' },
      {
        label: 'quickstart.localDb',
        code: [
          'cp apps/gateway/.env.example apps/gateway/.env',
          'cp apps/crawler/.env.example apps/crawler/.env',
          'cp apps/admin-ui/.env.example apps/admin-ui/.env',
          'export DATABASE_URL=postgres://gateway:gateway@localhost:15432/gateway',
          'pnpm db:migrate && pnpm db:seed',
        ].join('\n'),
      },
      {
        label: 'quickstart.localRun',
        code: ['pnpm dev                                  # gateway :4000', 'pnpm dev:upstream                         # fake HR API :4010', 'pnpm --filter @mcp-gateway/crawler dev', 'pnpm --filter @mcp-gateway/admin-ui dev   # Admin UI :5180'].join('\n'),
      },
      { label: 'quickstart.localOpen' },
    ],
  },
  connect: {
    label: 'quickstart.tabConnect',
    steps: [
      { label: 'quickstart.connectOauth', code: 'claude mcp add --transport http mcp-gateway https://mcp.example.com/mcp/omni' },
      { label: 'quickstart.connectOauthNote' },
      { label: 'quickstart.connectToken', code: `claude mcp add --transport http mcp-gateway http://localhost:4000/mcp/omni \\\n  --header "Authorization: Bearer ${DEV_TOKEN}"` },
      {
        label: 'quickstart.connectSdk',
        lang: 'ts',
        code: [
          "import { Client } from '@modelcontextprotocol/sdk/client/index.js';",
          "import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';",
          '',
          "const client = new Client({ name: 'my-agent', version: '1.0.0' });",
          "await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:4000/mcp'), {",
          '  requestInit: { headers: { authorization: `Bearer ${process.env.MCP_GATEWAY_TOKEN}` } },',
          '}));',
          "const r = await client.callTool({ name: 'rh_colaborador_get', arguments: { id: 'col-00001' } });",
        ].join('\n'),
      },
    ],
  },
};

type TabId = keyof typeof TABS;

export function Quickstart() {
  const t = useT();
  const [active, setActive] = useState<TabId>('docker');
  return (
    <section className="section" id="quickstart">
      <div className="container">
        <SectionHead index="10" label={t('quickstart.label')} title={t('quickstart.title')} lead={t('quickstart.lead')} />
        <Reveal>
          <div className="tabs" role="tablist" aria-label={t('quickstart.label')}>
            {(Object.keys(TABS) as TabId[]).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`qs-${id}`}
                aria-selected={id === active}
                aria-controls="qs-panel"
                className={`tab ${id === active ? 'is-active' : ''}`}
                onClick={() => setActive(id)}
              >
                {t(TABS[id].label)}
              </button>
            ))}
          </div>
          <ol className="steps" role="tabpanel" id="qs-panel" aria-labelledby={`qs-${active}`} key={active}>
            {TABS[active].steps.map((s, i) => (
              <li key={s.label} className={s.code ? 'step' : 'step step-note'}>
                <span className="step-num mono-label">{String(i + 1).padStart(2, '0')}</span>
                <div className="step-body">
                  <p>{t(s.label)}</p>
                  {s.code && <CodeBlock code={s.code} lang={s.lang} />}
                </div>
              </li>
            ))}
          </ol>
          {active !== 'docker' && (
            <p className="callout">
              <TriangleAlert size={16} />
              {t('quickstart.devOnly')}
            </p>
          )}
        </Reveal>
      </div>
    </section>
  );
}
