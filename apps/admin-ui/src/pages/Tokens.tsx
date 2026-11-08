import { KeyRound, PlugZap } from 'lucide-react';
import { useState } from 'react';
import { useSession } from '../api/session';
import { ConnectedApps } from '../components/ConnectedApps';
import { TokenList } from '../components/TokenList';
import { PageHeader, Tabs } from '../components/ui';
import { useT } from '../i18n';
import { rich } from '../lib/rich';

type TokensTab = 'mine' | 'apps';

/** API tokens of the signed-in user (to connect MCP clients) and the apps they connected over OAuth (ADR-030). */
export function TokensPage() {
  const t = useT();
  const { me } = useSession();
  const [tab, setTab] = useState<TokensTab>('mine');
  // connected apps exist only for people of a tenant (platform admins have none)
  const hasApps = me.tenant !== null;
  return (
    <>
      <PageHeader
        title={t('tokens.title')}
        subtitle={rich(t, 'tokens.subtitle', {
          user: <span className="mono">{me.sub}</span>,
          header: <span className="mono">Authorization: Bearer &lt;token&gt;</span>,
        })}
      />
      <Tabs<TokensTab>
        tabs={[
          { id: 'mine', label: t('tokens.tabMine'), icon: <KeyRound size={20} /> },
          ...(hasApps ? [{ id: 'apps' as const, label: t('oauth.tabApps'), icon: <PlugZap size={20} /> }] : []),
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="content">
        {tab === 'mine' ? (
          <TokenList basePath="/me/tokens" />
        ) : (
          <div className="stack">
            <p className="hint" style={{ margin: 0 }}>{t('oauth.myAppsIntro')}</p>
            <ConnectedApps basePath="/me/oauth/grants" />
          </div>
        )}
      </div>
    </>
  );
}
