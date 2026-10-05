import { createTranslator, mergeCatalogs, type KeysOf, type Message } from '@mcp-gateway/i18n';
import { agents } from './messages/agents';
import { audit } from './messages/audit';
import { calls } from './messages/calls';
import { charts } from './messages/charts';
import { auth } from './messages/auth';
import { common } from './messages/common';
import { composer } from './messages/composer';
import { drift } from './messages/drift';
import { importer } from './messages/import';
import { observability } from './messages/observability';
import { pii } from './messages/pii';
import { playground } from './messages/playground';
import { policies } from './messages/policies';
import { projections } from './messages/projections';
import { servers } from './messages/servers';
import { settings } from './messages/settings';
import { shell } from './messages/shell';
import { sources } from './messages/sources';
import { tokens } from './messages/tokens';
import { toolDrawer } from './messages/toolDrawer';
import { tools } from './messages/tools';
import { users } from './messages/users';

const AREAS = [common, shell, auth, tools, toolDrawer, sources, servers, policies, pii, projections, composer, playground, drift, audit, users, tokens, importer, settings, charts, observability, calls, agents] as const;

export type UiMessageKey = KeysOf<(typeof AREAS)[number]>;
export type UiMessage = Message<UiMessageKey>;

export const uiCatalog = mergeCatalogs(AREAS);
export const translateUi = createTranslator<UiMessageKey>(uiCatalog);
