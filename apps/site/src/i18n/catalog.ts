import { createTranslator, mergeCatalogs, type KeysOf } from '@mcp-gateway/i18n';
import { endpoints } from './messages/endpoints';
import { features } from './messages/features';
import { footer } from './messages/footer';
import { genui } from './messages/genui';
import { hero } from './messages/hero';
import { nav } from './messages/nav';
import { perf } from './messages/perf';
import { pillars } from './messages/pillars';
import { pipeline } from './messages/pipeline';
import { problem } from './messages/problem';
import { quickstart } from './messages/quickstart';
import { servers } from './messages/servers';
import { sources } from './messages/sources';

const AREAS = [nav, hero, problem, pillars, servers, pipeline, sources, features, genui, endpoints, perf, quickstart, footer] as const;

export type SiteMessageKey = KeysOf<(typeof AREAS)[number]>;

export const siteCatalog = mergeCatalogs(AREAS);
export const translateSite = createTranslator<SiteMessageKey>(siteCatalog);
