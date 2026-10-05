import { KeyRound } from 'lucide-react';
import { useSession } from '../api/session';
import { TokenList } from '../components/TokenList';
import { PageHeader, Tabs } from '../components/ui';
import { useT } from '../i18n';
import { rich } from '../lib/rich';

/** API tokens of the signed-in user (to connect MCP clients). */
export function TokensPage() {
  const t = useT();
  const { me } = useSession();
  return (
    <>
      <PageHeader
        title={t('tokens.title')}
        subtitle={rich(t, 'tokens.subtitle', {
          user: <span className="mono">{me.sub}</span>,
          header: <span className="mono">Authorization: Bearer &lt;token&gt;</span>,
        })}
      />
      <Tabs tabs={[{ id: 'mine', label: t('tokens.tabMine'), icon: <KeyRound size={20} /> }]} value="mine" onChange={() => undefined} />
      <div className="content">
        <TokenList basePath="/me/tokens" />
      </div>
    </>
  );
}
