import { defineMessages } from '../messages';

/** Tenant LLM provider configuration and calls (ADR-015). */
export const llm = defineMessages('llm', {
  en: {
    'llm.notConfigured': 'no LLM provider is configured for this tenant; a gateway-admin can set it up in Settings',
    'llm.noApiKey': 'the LLM provider has no API key configured',
    'llm.baseUrlRequired': 'a base URL is required for OpenAI-compatible providers',
    'llm.invalidKey': 'the LLM provider rejected the API key',
    'llm.providerRateLimited': 'the LLM provider is limiting requests; try again later',
    'llm.providerError': 'LLM provider error: {error}',
    'llm.timeout': 'the LLM provider did not answer in time',
    'llm.invalidResponse': 'the LLM provider returned an invalid response',
    'llm.refused': 'the model refused the request',
    'llm.truncated': 'the model response was truncated',
  },
  'pt-BR': {
    'llm.notConfigured': 'nenhum provedor de LLM configurado para este tenant; um gateway-admin pode configurar em Configurações',
    'llm.noApiKey': 'o provedor de LLM não tem API key configurada',
    'llm.baseUrlRequired': 'a URL base é obrigatória para provedores compatíveis com OpenAI',
    'llm.invalidKey': 'o provedor de LLM recusou a API key',
    'llm.providerRateLimited': 'o provedor de LLM está limitando as requisições; tente mais tarde',
    'llm.providerError': 'erro do provedor de LLM: {error}',
    'llm.timeout': 'o provedor de LLM não respondeu a tempo',
    'llm.invalidResponse': 'o provedor de LLM devolveu uma resposta inválida',
    'llm.refused': 'o modelo recusou o pedido',
    'llm.truncated': 'a resposta do modelo foi truncada',
  },
  es: {
    'llm.notConfigured': 'no hay un proveedor de LLM configurado para este tenant; un gateway-admin puede configurarlo en Configuración',
    'llm.noApiKey': 'el proveedor de LLM no tiene API key configurada',
    'llm.baseUrlRequired': 'la URL base es obligatoria para proveedores compatibles con OpenAI',
    'llm.invalidKey': 'el proveedor de LLM rechazó la API key',
    'llm.providerRateLimited': 'el proveedor de LLM está limitando las solicitudes; inténtalo más tarde',
    'llm.providerError': 'error del proveedor de LLM: {error}',
    'llm.timeout': 'el proveedor de LLM no respondió a tiempo',
    'llm.invalidResponse': 'el proveedor de LLM devolvió una respuesta inválida',
    'llm.refused': 'el modelo rechazó la solicitud',
    'llm.truncated': 'la respuesta del modelo fue truncada',
  },
});
