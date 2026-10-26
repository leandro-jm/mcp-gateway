# ADR-005: Tema e stack da Admin UI

- Status: substituído pelo ADR-026 (tokens, linguagem visual e layout); a stack continua valendo
- Data: 2026-10-03

## Contexto
A F10 pede uma Admin UI em React + Vite + TS com login próprio (usuário e senha, ADR-011). A referência visual dada é o console da E2B: escuro, tipografia mono em rótulos, acento laranja e sem sombras.

## Decisão
**Stack**
- React 19 + Vite, TanStack Query (cache e refetch de dados da Admin API), React Router. O login usa a Admin API (`POST /auth/login`) e guarda o token de sessão em `sessionStorage` (ADR-011).
- CodeMirror (YAML e JSON) no Composer e nos editores. `diff` para comparar versões.
- Fontes IBM Plex Sans e IBM Plex Mono via `@fontsource`, empacotadas sem depender da rede.
- Em dev, o Vite faz proxy de `/admin`, `/mcp` e `/sdk` para o gateway (mesmo origin, sem CORS).
- Escolhi React Router no lugar do TanStack Router previsto no plano inicial: o roteamento é simples e não justifica a geração de rotas tipadas.

**Tokens** (`src/theme/tokens.css`). O modo escuro é o padrão, como a referência:
- Fundo `#0a0a0a`; superfícies `#111111` e `#161616`; bordas `#262626`.
- Texto `#ededed`; texto secundário `#8f8f8f`.
- Acento laranja `#ff8a1f`: item ativo da sidebar, sublinhado da aba ativa, tokens de código e valores de destaque.
- Sucesso/LIVE `#22c55e`; perigo `#ef4444`; aviso `#f5a524`.

**Tema claro e seletor**
- Seletor Sistema / Claro / Escuro na topbar (`ThemeSelector`). A preferência fica em `localStorage` (`mcp-gw:theme`) e é aplicada antes da primeira pintura por um script inline no `index.html`.
- "Claro" e "Escuro" fixam `html[data-theme]`. "Sistema" remove o atributo e segue `prefers-color-scheme`.
- A paleta clara redefine os mesmos tokens. Mudam: fundo branco, bordas `#e3e3e3`, acento `#c25700` (contraste AA no branco) e botão primário invertido (preto com texto branco).
- Nenhuma cor fica fixa em componentes: CSS, editor CodeMirror, logo e ilustração usam tokens.

**Linguagem visual**
- Títulos de página em caixa alta e negrito. Rótulos de seção e cabeçalhos de tabela em mono, caixa alta, cor secundária.
- Bordas de 1px, cantos retos (raio ≤ 2px), sem sombras.
- Botão primário com fundo branco e texto preto; secundário com borda.
- Empty state em duas colunas: ilustração de cubo em dither (SVG) e abas de snippet com copiar.

**Layout**
- Topbar: logo, breadcrumb `Tenant ⌄ / Gateway [ENV]`, "Ir para… ⌘K" e avatar.
- Sidebar com grupos:
  - topo: Tools, Sources, MCP Servers, Playground;
  - CONFIGURE: Composer, Policies, PII, Projections;
  - MANAGE: Drift, Audit.
- Páginas com título, abas sublinhadas e toolbar: busca com atalho `/`, Filters, contador, refresh, auto-refresh e ação primária.

## Consequências
A UI fica consistente com a referência e o acesso respeita a Admin API: `tool-owner` vê e altera só o que a API permite. O código da UI não tem lógica de autorização própria.
