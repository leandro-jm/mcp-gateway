import { defineMessages } from '../messages';

/** PII redaction and detokenization. */
export const pii = defineMessages('pii', {
  en: {
    'pii.invalidToken': 'invalid or expired PII token',
    'pii.tokenFieldNotAllowed': 'PII token ({detector}) cannot be used in field {field}',
  },
  'pt-BR': {
    'pii.invalidToken': 'token de PII inválido ou expirado',
    'pii.tokenFieldNotAllowed': 'token de PII ({detector}) não pode ser usado no campo {field}',
  },
  es: {
    'pii.invalidToken': 'token de PII inválido o expirado',
    'pii.tokenFieldNotAllowed': 'el token de PII ({detector}) no puede usarse en el campo {field}',
  },
});
