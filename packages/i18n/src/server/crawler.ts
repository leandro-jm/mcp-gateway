import { defineMessages } from '../messages';

/** Crawler errors persisted on crawl runs (apps/crawler). */
export const crawler = defineMessages('crawler', {
  en: {
    'crawler.noSpecSource': 'source has neither openapiUrl nor openapiInline',
    'crawler.tokenFailed': 'failed to obtain a token to download the spec: HTTP {status}',
    'crawler.tokenMissing': 'token endpoint did not return access_token',
    'crawler.specUrlBlocked': 'spec URL blocked by the network policy: {error}',
    'crawler.specDownloadFailed': 'failed to download the spec: {error}',
    'crawler.specHttpError': 'failed to download the spec: HTTP {status}',
    'crawler.specTooLarge': 'spec exceeds {max} bytes',
    'crawler.specEmptyBody': 'response has no body',
    'crawler.specInvalidFormat': 'spec is not valid JSON/YAML: {error}',
  },
  'pt-BR': {
    'crawler.noSpecSource': 'source sem openapiUrl nem openapiInline',
    'crawler.tokenFailed': 'falha ao obter token para baixar a spec: HTTP {status}',
    'crawler.tokenMissing': 'endpoint de token não retornou access_token',
    'crawler.specUrlBlocked': 'URL da spec bloqueada pela política de rede: {error}',
    'crawler.specDownloadFailed': 'falha ao baixar a spec: {error}',
    'crawler.specHttpError': 'falha ao baixar a spec: HTTP {status}',
    'crawler.specTooLarge': 'spec excede {max} bytes',
    'crawler.specEmptyBody': 'resposta sem corpo',
    'crawler.specInvalidFormat': 'spec não é JSON/YAML válido: {error}',
  },
  es: {
    'crawler.noSpecSource': 'la source no tiene openapiUrl ni openapiInline',
    'crawler.tokenFailed': 'no se pudo obtener un token para descargar la spec: HTTP {status}',
    'crawler.tokenMissing': 'el endpoint de token no devolvió access_token',
    'crawler.specUrlBlocked': 'URL de la spec bloqueada por la política de red: {error}',
    'crawler.specDownloadFailed': 'no se pudo descargar la spec: {error}',
    'crawler.specHttpError': 'no se pudo descargar la spec: HTTP {status}',
    'crawler.specTooLarge': 'la spec supera {max} bytes',
    'crawler.specEmptyBody': 'respuesta sin cuerpo',
    'crawler.specInvalidFormat': 'la spec no es JSON/YAML válido: {error}',
  },
});
