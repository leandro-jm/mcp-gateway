/**
 * Natural-language tool search (F7.1), pure part: indexed text and query.
 * The query is an OR of terms (with synonyms); ranking is left to Postgres (ts_rank).
 */

const STOPWORDS = new Set(
  (
    'a o as os um uma uns umas de do da dos das no na nos nas em por para pra com sem sob sobre entre e ou que qual quais ' +
    'quem quando onde como meu minha meus minhas seu sua seus suas esse essa isso este esta isto aquele aquela ao aos à às ' +
    'eu voce você ele ela eles elas nos nós me mim te lhe se ser estar ter haver fazer quero queria gostaria preciso precisa ' +
    'pode poderia favor por-favor algum alguma alguns algumas todo toda todos todas the of to for and or in on by with is are'
  ).split(/\s+/),
);

/**
 * Domain thesaurus: verbs (Portuguese ↔ generated English names) and common HR/ops nouns.
 * Configurable per tenant in the future; the default list covers the vocabulary of the generated APIs.
 */
export const DEFAULT_THESAURUS: Record<string, string[]> = {
  listar: ['list', 'lista', 'listagem', 'consultar'],
  lista: ['list', 'listar'],
  quais: ['list'],
  mostrar: ['list', 'exibir'],
  ver: ['list', 'get', 'consultar'],
  consultar: ['get', 'list', 'busca', 'consulta'],
  buscar: ['get', 'search', 'busca', 'consultar'],
  procurar: ['search', 'busca', 'get'],
  pesquisar: ['search', 'busca'],
  detalhe: ['get', 'detalhes'],
  detalhes: ['get'],
  obter: ['get'],
  cadastrar: ['create', 'cadastra', 'registrar', 'criar'],
  registrar: ['create', 'registra', 'cadastrar'],
  criar: ['create', 'cria', 'cadastrar'],
  incluir: ['create', 'inclui', 'adicionar'],
  adicionar: ['create', 'add', 'incluir'],
  novo: ['create'],
  nova: ['create'],
  lancar: ['create', 'registrar'],
  atualizar: ['update', 'atualiza', 'alterar'],
  alterar: ['update', 'altera', 'atualizar', 'patch'],
  editar: ['update', 'patch', 'alterar'],
  mudar: ['update', 'alterar'],
  corrigir: ['update', 'patch'],
  remover: ['delete', 'remove', 'excluir'],
  excluir: ['delete', 'exclui', 'remover'],
  apagar: ['delete', 'remover', 'excluir'],
  deletar: ['delete', 'remover'],
  cancelar: ['cancel', 'cancela'],
  aprovar: ['approve', 'aprova'],
  exportar: ['export', 'exporta'],
  funcionario: ['colaborador', 'empregado'],
  funcionarios: ['colaboradores', 'empregados'],
  empregado: ['colaborador', 'funcionario'],
  empregados: ['colaboradores', 'funcionarios'],
  pessoa: ['colaborador'],
  pessoas: ['colaboradores'],
  ponto: ['marcacao', 'marcacoes'],
  batida: ['marcacao'],
  batidas: ['marcacoes'],
  turno: ['escala'],
  turnos: ['escalas'],
  jornada: ['escala'],
  salario: ['holerite', 'remuneracao', 'folha'],
  contracheque: ['holerite'],
  folga: ['ferias', 'afastamento'],
  licenca: ['afastamento'],
  atestado: ['afastamento'],
  nf: ['nota', 'fiscal'],
  boleto: ['pagamento', 'fatura'],
  cliente: ['clientes'],
  posto: ['postos', 'site'],
  local: ['posto'],
};

export function normalizeWord(w: string): string {
  return w
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .map(normalizeWord)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

export interface ExpandedQuery {
  /** Query terms (without stopwords). */
  terms: string[];
  /** Thesaurus synonyms (lower weight in ranking). */
  synonyms: string[];
}

/** Query terms + synonyms (no duplicates, only [a-z0-9]). */
export function expandQuery(query: string, thesaurus: Record<string, string[]> = DEFAULT_THESAURUS): ExpandedQuery {
  const terms = [...new Set(tokenize(query))].slice(0, 20);
  const synonyms = new Set<string>();
  for (const t of terms) for (const syn of thesaurus[t] ?? []) for (const s of tokenize(syn)) if (!terms.includes(s)) synonyms.add(s);
  return { terms, synonyms: [...synonyms].slice(0, 30) };
}

const WRITE_VERBS = new Set(['create', 'update', 'delete', 'patch', 'cancel', 'approve', 'add', 'remove', 'set', 'register', 'export', 'import', 'send']);
const ID_WORDS = new Set(['id', 'identificador', 'codigo', 'detalhe', 'detalhes', 'especifico', 'especifica']);

export type QueryIntent = 'write' | 'read-one' | 'read-many';

/** Query intent, to break ties between operations on the same resource. */
export function queryIntent(q: ExpandedQuery): QueryIntent {
  if ([...q.terms, ...q.synonyms].some((t) => WRITE_VERBS.has(t))) return 'write';
  return q.terms.some((t) => ID_WORDS.has(t)) ? 'read-one' : 'read-many';
}

/** OR `tsquery` (safe: terms already normalized to [a-z0-9]). */
export function toOrTsQuery(terms: string[]): string {
  return terms.filter((t) => /^[a-z0-9]+$/.test(t)).join(' | ');
}

/**
 * Effect sentence of generated tools, indexed in the search language (Portuguese FTS, ADR-009).
 * Agents see a localized sentence appended at tools/list time instead (ADR-012); the index keeps
 * this one because it helps tell write operations from reads.
 */
function indexedEffect(t: { kind?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }): string {
  if (t.kind !== 'openapi' || !t.annotations) return '';
  if (t.annotations.readOnlyHint) return 'Somente leitura.';
  return t.annotations.destructiveHint ? 'Altera dados (operação destrutiva).' : 'Altera dados.';
}

/** Indexed text of a tool (effective values, with overrides). */
export function buildSearchText(t: {
  name: string;
  title?: string | null;
  description: string;
  inputSchema?: Record<string, unknown>;
  tags?: string[];
  kind?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}): string {
  const props = Object.keys(((t.inputSchema ?? {}).properties as Record<string, unknown> | undefined) ?? {});
  const description = [t.description, indexedEffect(t)].filter(Boolean).join(' ');
  return [t.name, t.title ?? '', description, props.join(' '), (t.tags ?? []).join(' ')].filter(Boolean).join('\n');
}
