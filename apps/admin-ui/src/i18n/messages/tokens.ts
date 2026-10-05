import { defineMessages } from '@mcp-gateway/i18n';

/** "Tokens" page (the signed-in user's API tokens). */
export const tokens = defineMessages('tokens', {
  en: {
    'tokens.title': 'Tokens',
    'tokens.subtitle': 'API tokens of {user}. Use them in {header} in MCP clients.',
    'tokens.tabMine': 'My tokens',
  },
  'pt-BR': {
    'tokens.title': 'Tokens',
    'tokens.subtitle': 'Tokens de API de {user}. Use em {header} nos clientes MCP.',
    'tokens.tabMine': 'Meus tokens',
  },
  es: {
    'tokens.title': 'Tokens',
    'tokens.subtitle': 'Tokens de API de {user}. Úselos en {header} en los clientes MCP.',
    'tokens.tabMine': 'Mis tokens',
  },
});
