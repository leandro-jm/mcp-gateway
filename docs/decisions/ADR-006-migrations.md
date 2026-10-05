# ADR-006: Migrations up/down

- Status: aceito
- Data: 2026-10-03

## Contexto
O CA da F1.1 exige que as migrations "sobem e descem". O `drizzle-kit` gera apenas o SQL de subida e o próprio `migrate` do Drizzle não faz rollback.

## Decisão
- O schema TypeScript (`packages/db/src/schema`) é a fonte da verdade. O SQL de subida é gerado com `pnpm --filter @mcp-gateway/db db:generate` (drizzle-kit) em `packages/db/migrations/NNNN_nome.sql`.
- Toda migration tem um par escrito à mão em `packages/db/migrations/down/NNNN_nome.sql`.
- Um runner próprio (`packages/db/src/migrate.ts`) aplica as migrations em ordem, numa transação por arquivo, e registra cada uma em `schema_migrations`. `down(n)` reverte as últimas `n`.
- SQL que o drizzle-kit não expressa (particionamento, FTS, triggers) vai em migrations escritas à mão (`NNNN_nome.sql`), sem passar pelo drizzle-kit.
- Um teste de integração sobe tudo, desce tudo e sobe de novo.

## Consequências
O journal do drizzle-kit (`meta/`) continua sendo usado só para gerar diffs. O runtime usa apenas o runner próprio.

## Nota operacional
Migrations escritas à mão (ex.: `0006_tool_search_index.sql`) não entram no journal do drizzle-kit. Por isso a próxima migration gerada pode vir com um número já usado. Nesse caso, renomeie o arquivo para o próximo número livre e ajuste o `tag` correspondente em `migrations/meta/_journal.json`.
