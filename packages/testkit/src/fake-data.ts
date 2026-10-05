/** Fictitious, deterministic data for the fake HR upstream. */

export interface Colaborador {
  id: string;
  matricula: string;
  nome: string;
  cpf: string;
  pis: string;
  email: string;
  telefone: string;
  salario: number;
  data_nascimento: string;
  endereco: { logradouro: string; cidade: string; uf: string; cep: string };
  cargo: string;
  unidade_id: string;
  escala_id: string;
  ativo: boolean;
}

export interface Escala {
  id: string;
  nome: string;
  inicio: string;
  fim: string;
  dias: string[];
}

export interface Marcacao {
  id: string;
  colaborador_id: string;
  data_hora: string;
  tipo: 'entrada' | 'saida';
  origem: string;
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function digits(rand: () => number, n: number): number[] {
  return Array.from({ length: n }, () => Math.floor(rand() * 10));
}

/** Generates a valid CPF (with check digits), formatted `000.000.000-00`. */
export function fakeCpf(rand: () => number): string {
  const d = digits(rand, 9);
  const dv = (base: number[]) => {
    const sum = base.reduce((acc, v, i) => acc + v * (base.length + 1 - i), 0);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  d.push(dv(d));
  d.push(dv(d));
  const s = d.join('');
  return `${s.slice(0, 3)}.${s.slice(3, 6)}.${s.slice(6, 9)}-${s.slice(9)}`;
}

/** Generates a valid PIS/NIS, formatted `000.00000.00-0`. */
export function fakePis(rand: () => number): string {
  const d = digits(rand, 10);
  const weights = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const sum = d.reduce((acc, v, i) => acc + v * weights[i]!, 0);
  const r = 11 - (sum % 11);
  d.push(r === 10 || r === 11 ? 0 : r);
  const s = d.join('');
  return `${s.slice(0, 3)}.${s.slice(3, 8)}.${s.slice(8, 10)}-${s.slice(10)}`;
}

const NOMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Fábio', 'Gabriela', 'Heitor', 'Isabela', 'João'];
const SOBRENOMES = ['Silva', 'Souza', 'Oliveira', 'Santos', 'Pereira', 'Lima', 'Costa', 'Ribeiro', 'Almeida'];
const CARGOS = ['Vigilante', 'Porteiro', 'Supervisor', 'Recepcionista', 'Auxiliar de limpeza'];
const CIDADES: Array<[string, string]> = [
  ['São Paulo', 'SP'],
  ['Curitiba', 'PR'],
  ['Porto Alegre', 'RS'],
  ['Belo Horizonte', 'MG'],
];

export const ESCALAS: Escala[] = [
  { id: 'esc-12x36-d', nome: '12x36 diurno', inicio: '07:00', fim: '19:00', dias: ['alternados'] },
  { id: 'esc-12x36-n', nome: '12x36 noturno', inicio: '19:00', fim: '07:00', dias: ['alternados'] },
  { id: 'esc-5x2', nome: '5x2 comercial', inicio: '08:00', fim: '17:00', dias: ['seg', 'ter', 'qua', 'qui', 'sex'] },
  { id: 'esc-6x1', nome: '6x1', inicio: '06:00', fim: '14:20', dias: ['seg', 'ter', 'qua', 'qui', 'sex', 'sab'] },
];

export function generateColaboradores(count: number, seed = 42): Colaborador[] {
  const rand = prng(seed);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  return Array.from({ length: count }, (_, i) => {
    const nome = `${pick(NOMES)} ${pick(SOBRENOMES)}`;
    const [cidade, uf] = pick(CIDADES);
    const id = `col-${String(i + 1).padStart(5, '0')}`;
    const cep = digits(rand, 8).join('');
    return {
      id,
      matricula: String(10000 + i),
      nome,
      cpf: fakeCpf(rand),
      pis: fakePis(rand),
      email: `${nome.toLowerCase().normalize('NFD').replace(/[^a-z ]/g, '').replace(' ', '.')}${i}@empresa.example`,
      telefone: `(${11 + Math.floor(rand() * 80)}) 9${digits(rand, 4).join('')}-${digits(rand, 4).join('')}`,
      salario: Math.round((1800 + rand() * 6000) * 100) / 100,
      data_nascimento: `19${70 + Math.floor(rand() * 30)}-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}`,
      endereco: {
        logradouro: `Rua ${pick(SOBRENOMES)}, ${1 + Math.floor(rand() * 999)}`,
        cidade,
        uf,
        cep: `${cep.slice(0, 5)}-${cep.slice(5)}`,
      },
      cargo: pick(CARGOS),
      unidade_id: `uni-${1 + Math.floor(rand() * 5)}`,
      escala_id: pick(ESCALAS).id,
      ativo: rand() > 0.1,
    };
  });
}

export function generateMarcacoes(colaboradores: Colaborador[], perColaborador = 4, seed = 7): Marcacao[] {
  const rand = prng(seed);
  const out: Marcacao[] = [];
  let n = 0;
  for (const c of colaboradores) {
    for (let i = 0; i < perColaborador; i++) {
      const day = 1 + Math.floor(i / 2);
      const hour = i % 2 === 0 ? 7 : 19;
      out.push({
        id: `mar-${String(++n).padStart(6, '0')}`,
        colaborador_id: c.id,
        data_hora: `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:0${Math.floor(rand() * 9)}:00-03:00`,
        tipo: i % 2 === 0 ? 'entrada' : 'saida',
        origem: rand() > 0.5 ? 'app' : 'relogio',
      });
    }
  }
  return out;
}
