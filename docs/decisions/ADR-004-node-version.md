# ADR-004: Node 22 como alvo, Node 26 no desenvolvimento local

- Status: aceito
- Data: 2026-10-03

## Contexto
O PLAN pede Node 22 LTS. A máquina de desenvolvimento roda Node 26. Além disso, o TypeScript 7 (compilador nativo) ainda não é suportado pelo typescript-eslint.

## Decisão
- `engines.node >= 22.12`, `.nvmrc = 22`, imagens Docker `node:22-alpine`. A CI roda em Node 22.
- Nenhuma API exclusiva do Node > 22 é usada.
- TypeScript fixado em `~6.0`, com `moduleResolution: bundler`. Os apps são empacotados com `tsup`.

## Consequências
Local e CI podem divergir em detalhes de runtime. A CI em Node 22 é a referência.
