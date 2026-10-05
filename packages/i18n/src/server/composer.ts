import { defineMessages } from '../messages';

/** Natural-language composer: generated composite lint and generation flow (packages/composer, ADR-015). */
export const composer = defineMessages('composer', {
  en: {
    'composer.forbiddenFunction': 'function {fn} is not allowed in generated composites',
    'composer.nameTaken': 'a tool named {name} already exists; choose another name',
    'composer.toolNotCandidate': 'tool {tool} is not in the provided catalog',
    'composer.invalidProposal': 'the model response is not a valid proposal: {error}',
    'composer.promptTooLong': 'request too long (max {max} characters)',
    'composer.noCandidates': 'no tools available in the catalog to compose',
  },
  'pt-BR': {
    'composer.forbiddenFunction': 'a função {fn} não é permitida em compostas geradas',
    'composer.nameTaken': 'já existe uma tool chamada {name}; escolha outro nome',
    'composer.toolNotCandidate': 'a tool {tool} não está no catálogo fornecido',
    'composer.invalidProposal': 'a resposta do modelo não é uma proposta válida: {error}',
    'composer.promptTooLong': 'pedido longo demais (máximo de {max} caracteres)',
    'composer.noCandidates': 'nenhuma tool disponível no catálogo para compor',
  },
  es: {
    'composer.forbiddenFunction': 'la función {fn} no está permitida en compuestas generadas',
    'composer.nameTaken': 'ya existe una tool llamada {name}; elige otro nombre',
    'composer.toolNotCandidate': 'la tool {tool} no está en el catálogo proporcionado',
    'composer.invalidProposal': 'la respuesta del modelo no es una propuesta válida: {error}',
    'composer.promptTooLong': 'solicitud demasiado larga (máximo {max} caracteres)',
    'composer.noCandidates': 'no hay tools disponibles en el catálogo para componer',
  },
});
