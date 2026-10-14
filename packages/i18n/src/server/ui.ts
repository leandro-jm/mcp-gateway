import { defineMessages } from '../messages';

/** Generative UI on tool results (ADR-022). */
export const ui = defineMessages('ui', {
  en: {
    'ui.confirmationRequired':
      '{tool} has an irreversible effect and was not executed. The user must review the plan and confirm it in the interface; do not call it again.',
    'ui.fieldRequired': 'Required field.',
    'ui.fieldInvalid': 'Invalid value.',
    'ui.invalidViews': 'invalid view spec: {issues}',
    'ui.invalidTheme': 'invalid theme: {issues}',
    'ui.invalidTileUrl': 'tile_url must be an https tile template with z, x and y placeholders',
    'ui.noSuggestion': 'no view could be inferred from this tool contract',
  },
  'pt-BR': {
    'ui.confirmationRequired':
      '{tool} tem efeito irreversível e não foi executada. O usuário precisa revisar o plano e confirmar na interface; não chame de novo.',
    'ui.fieldRequired': 'Campo obrigatório.',
    'ui.fieldInvalid': 'Valor inválido.',
    'ui.invalidViews': 'especificação de view inválida: {issues}',
    'ui.invalidTheme': 'tema inválido: {issues}',
    'ui.invalidTileUrl': 'tile_url deve ser um template https de tiles com os marcadores z, x e y',
    'ui.noSuggestion': 'não foi possível inferir uma view a partir do contrato desta tool',
  },
  es: {
    'ui.confirmationRequired':
      '{tool} tiene un efecto irreversible y no se ejecutó. El usuario debe revisar el plan y confirmarlo en la interfaz; no la llame de nuevo.',
    'ui.fieldRequired': 'Campo obligatorio.',
    'ui.fieldInvalid': 'Valor inválido.',
    'ui.invalidViews': 'especificación de vista inválida: {issues}',
    'ui.invalidTheme': 'tema inválido: {issues}',
    'ui.invalidTileUrl': 'tile_url debe ser una plantilla https de teselas con los marcadores z, x e y',
    'ui.noSuggestion': 'no se pudo inferir una vista a partir del contrato de esta herramienta',
  },
});
