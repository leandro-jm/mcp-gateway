import { defineMessages } from '../messages';

/**
 * Configuration and outbound network policy (packages/core `config`/`network`, packages/net).
 * `config.outbound*` are the reasons carried by `OutboundBlocked.msg`.
 */
export const config = defineMessages('config', {
  en: {
    'config.outboundInvalidUrl': 'invalid URL: {url}',
    'config.outboundProtocol': 'protocol not allowed: {protocol}',
    'config.outboundCredentials': 'credentials in the URL are not allowed',
    'config.outboundNotAllowlisted': "host {host} is not in the tenant's allowlist",
    'config.outboundInternalHost': 'internal host not allowed: {host}',
    'config.outboundPrivateAddress': 'private address not allowed: {host}',
    'config.outboundResolvesPrivate': 'destination resolves to a private address',
    'config.unsafeRegex': 'regular expression not accepted: {pattern}. Use at most {max} characters, without nested quantifiers, quantified alternations or backreferences',
  },
  'pt-BR': {
    'config.outboundInvalidUrl': 'URL inválida: {url}',
    'config.outboundProtocol': 'protocolo não permitido: {protocol}',
    'config.outboundCredentials': 'credenciais na URL não são permitidas',
    'config.outboundNotAllowlisted': 'host {host} fora da allowlist do tenant',
    'config.outboundInternalHost': 'host interno não permitido: {host}',
    'config.outboundPrivateAddress': 'endereço privado não permitido: {host}',
    'config.outboundResolvesPrivate': 'destino resolve para endereço privado',
    'config.unsafeRegex': 'expressão regular não aceita: {pattern}. Use no máximo {max} caracteres, sem quantificadores aninhados, alternâncias quantificadas ou referências retroativas',
  },
  es: {
    'config.outboundInvalidUrl': 'URL inválida: {url}',
    'config.outboundProtocol': 'protocolo no permitido: {protocol}',
    'config.outboundCredentials': 'no se permiten credenciales en la URL',
    'config.outboundNotAllowlisted': 'el host {host} no está en la allowlist del tenant',
    'config.outboundInternalHost': 'host interno no permitido: {host}',
    'config.outboundPrivateAddress': 'dirección privada no permitida: {host}',
    'config.outboundResolvesPrivate': 'el destino resuelve a una dirección privada',
    'config.unsafeRegex': 'expresión regular no aceptada: {pattern}. Use como máximo {max} caracteres, sin cuantificadores anidados, alternancias cuantificadas ni referencias inversas',
  },
});
