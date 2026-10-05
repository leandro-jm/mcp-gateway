import { defineMessages } from '../messages';

/** Response projection (packages/projection). */
export const projection = defineMessages('projection', {
  en: {
    'projection.stillExceedsMaxBytes': 'response exceeds max_bytes ({maxBytes}) even after cutting',
  },
  'pt-BR': {
    'projection.stillExceedsMaxBytes': 'resposta excede max_bytes ({maxBytes}) mesmo após corte',
  },
  es: {
    'projection.stillExceedsMaxBytes': 'la respuesta excede max_bytes ({maxBytes}) incluso después del recorte',
  },
});
