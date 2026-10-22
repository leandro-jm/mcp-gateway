import { DEFAULT_LOCALE, type Locale } from '../locale';
import { createTranslator, mergeCatalogs, type KeysOf, type Message, type Params } from '../messages';
import { admin } from './admin';
import { analytics } from './analytics';
import { artifacts } from './artifacts';
import { auth } from './auth';
import { common, resource } from './common';
import { composer } from './composer';
import { composition } from './composition';
import { config } from './config';
import { crawler } from './crawler';
import { db } from './db';
import { importer } from './import';
import { llm } from './llm';
import { mcp } from './mcp';
import { pii } from './pii';
import { policy } from './policy';
import { projection } from './projection';
import { ui } from './ui';
import { proxy } from './proxy';
import { redaction } from './redaction';
import { router } from './router';
import { toolgen } from './toolgen';

export type { ResourceName } from './common';

const AREAS = [common, resource, auth, admin, proxy, pii, mcp, policy, composition, toolgen, crawler, db, config, projection, redaction, artifacts, importer, composer, llm, analytics, ui, router] as const;

/** Every backend message key (Admin API, MCP data plane, crawler, pure packages). */
export type ServerMessageKey = KeysOf<(typeof AREAS)[number]>;
export type ServerMessage = Message<ServerMessageKey>;

export const serverCatalog = mergeCatalogs(AREAS);

const translator = createTranslator<ServerMessageKey>(serverCatalog);

/** Renders a backend message in `locale` (English when omitted). */
export function translate(message: ServerMessage, locale: Locale = DEFAULT_LOCALE): string {
  return translator(locale, message);
}

/** Builds a typed backend message. */
export function msg(key: ServerMessageKey, params?: Params): ServerMessage {
  return params ? { key, params } : { key };
}

/** Third-party text that cannot be translated (upstream responses, library errors). */
export function raw(text: string): ServerMessage {
  return { key: 'common.raw', params: { text } };
}
