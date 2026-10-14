import { createTranslator, mergeCatalogs, type KeysOf } from '@mcp-gateway/i18n';
import { endpoints } from './messages/endpoints';
import { features } from './messages/features';
import { footer } from './messages/footer';
import { hero } from './messages/hero';
import { nav } from './messages/nav';
import { perf } from './messages/perf';
import { pipeline } from './messages/pipeline';
import { quickstart } from './messages/quickstart';
import { why } from './messages/why';

const AREAS = [nav, hero, why, pipeline, features, endpoints, perf, quickstart, footer] as const;

export type SiteMessageKey = KeysOf<(typeof AREAS)[number]>;

export const siteCatalog = mergeCatalogs(AREAS);
export const translateSite = createTranslator<SiteMessageKey>(siteCatalog);
