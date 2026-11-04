# ADR-029: Paginação de tabelas e skeletons de carregamento no Admin UI

- Status: aceito
- Data: 2026-11-04

## Contexto
As tabelas do Admin UI renderizam a lista inteira que a API devolve. Várias páginas buscam `?limit=500` e filtram em memória (Tools, Sources, Users, Tenants, Servers), e Audit e Drift cortam em 200 sem dizer que há mais. Só Calls tem um "carregar mais" por cursor. Enquanto os dados chegam, a maioria das telas mostra uma tabela vazia, uma aba em branco ou até a mensagem de lista vazia (TokenList). O único indicador é o `.loading` com spinner, usado em poucos lugares.

## Decisão
- **Um componente de paginação** (`components/Pagination.tsx`) para todas as tabelas, alimentado pelo hook `usePagination` (`lib/pagination.ts`):
  - mostra o intervalo ("1–25 de 312"), anterior/próxima e páginas numeradas com reticências;
  - tamanhos 10, 25, 50 e 100. A escolha do usuário fica no `localStorage` (preferência por navegador; sem armazenamento disponível, vale o padrão 25);
  - tabelas compactas (painéis, drawers, tabela-gêmea de gráfico) usam 10 por página, sem seletor de tamanho;
  - some quando os dados cabem na menor página, então tabelas pequenas ficam como estão;
  - volta à primeira página quando busca ou filtros mudam, e nunca fica além da última página quando a lista encolhe;
  - fatia os dados, não o markup: linhas expansíveis (Audit, importação) e seleção em massa continuam funcionando sobre a lista inteira.
- **Onde a paginação acontece:**
  - **No servidor**, quando a API já devolve `total` real e filtra no servidor: Audit (`limit`/`offset`, ADR-008). A página anterior fica na tela enquanto a próxima carrega.
  - **Por cursor**, em Calls: as páginas da tabela andam sobre as páginas já carregadas, e a próxima é buscada antes de o usuário chegar nela. O total aparece como "50+" enquanto houver mais.
  - **No cliente**, nas demais: as listas já chegam inteiras ou com limite do servidor, e a busca em memória continua igual. Trocar para paginação no servidor fica para quando uma lista passar desse limite na prática.
- **Skeletons** (`components/Skeleton.tsx`) no lugar de vazio ou spinner enquanto há dados carregando:
  - linhas de tabela com a mesma quantidade de colunas, para a página não pular quando os dados chegam;
  - blocos de cards, gráficos e painéis nas abas de observabilidade, agentes e configurações;
  - um esqueleto de página no `Suspense` das rotas lazy.
  - A mensagem de lista vazia só aparece depois do carregamento.
  - Acessibilidade: a região que carrega recebe `aria-busy`, as barras são `aria-hidden` e um texto `sr-only` anuncia o carregamento.
  - A animação (brilho) é desligada com `prefers-reduced-motion`.
- Textos novos no catálogo `common` nos três locales (ADR-012).

## Consequências
- O comportamento fica igual em todas as tabelas, e listas grandes deixam de produzir páginas com milhares de linhas.
- Na paginação no cliente, o limite do servidor (500) continua valendo. Uma lista maior que isso precisa migrar para paginação no servidor, como Audit.
- Projections passa a pedir a projeção só das tools visíveis, em vez de uma requisição por tool cadastrada.
