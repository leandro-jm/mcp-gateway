# ADR-028: Node 26 LTS como alvo único

- Status: aceito
- Data: 2026-11-04
- Substitui: ADR-004

## Contexto
O ADR-004 fixou o Node 22 como alvo (CI e imagens), com o Node 26 apenas no desenvolvimento local. Em 2026-10-28 o Node 26 ("Lithium") entrou em Active LTS (fim de vida em 2029-04-30); o Node 24 passou para manutenção em 2026-10-20 e o Node 22 está em manutenção até 2027-04-30.

Todas as faixas `engines.node` do `pnpm-lock.yaml` aceitam o Node 26. As únicas dependências nativas compiladas são `esbuild` e `msgpackr-extract` (N-API, com fallback em JS). `pnpm check` e `pnpm test` passam no Node 26.

A CI também emitia o aviso de descontinuação do runtime Node 20 das actions do GitHub (`actions/checkout@v4`, `docker/*@v3`, …).

## Decisão
- Node 26 LTS em todos os ambientes: `engines.node >= 26`, `.nvmrc = 26`, imagens `node:26-alpine`, CI com `NODE_VERSION: '26'`, `tsup` com `target: 'node26'` e `@types/node` 26.
- As actions do GitHub vão para as majors que rodam em Node 24 (`actions/checkout@v7`, `actions/setup-node@v7`, `pnpm/action-setup@v6`, `docker/*@v4`/`v6`/`v7`, …).
- TypeScript continua em `~6.0` (o typescript-eslint ainda não suporta o TS 7).

## Consequências
Local, CI e produção rodam o mesmo runtime, o que elimina a divergência do ADR-004. Quem roda o projeto precisa do Node 26 ou mais novo.

O Node 25+ não traz mais o corepack embutido. As imagens instalam `corepack` fixado (`npm install -g corepack@0.36.0`) antes do `corepack enable`, e os requisitos no README, no CONTRIBUTING e na landing page passam a indicar `npm i -g corepack && corepack enable`. Na CI, o `pnpm/action-setup` já instala o pnpm sem corepack.
