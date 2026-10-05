# ADR-008: Convenções da Admin API

- Status: aceito
- Data: 2026-10-03

## Contexto
A F1.3 introduz a Admin API (`/admin/v1`) com auth por role. O PLAN não define como o tenant alvo é escolhido nem o formato de erros e paginação.

## Decisão
- **AuthN**: `Authorization: Bearer <token>` opaco, emitido pelo próprio gateway e validado contra o Postgres (ADR-011). O data plane usa o mesmo verificador.
- **Roles e grupos**: vêm do usuário dono do token (`users.roles`, `users.groups`).
- **Tenant alvo**: rotas tenant-scoped usam o header `X-Tenant` (slug). Sem o header, vale o tenant do usuário. Só `gateway-admin` pode apontar para outro tenant. O admin de plataforma, que não tem tenant, sempre informa `X-Tenant`.
- **Tenants** (`/tenants`): exclusivo de `gateway-admin`.
- **Auth e usuários** (ADR-011): `POST /auth/login` é público (rate limit por usuário + IP) e `POST /auth/logout` revoga o token da requisição. `/users` e `/users/:id/tokens` são de `gateway-admin`, no tenant resolvido. `/me/tokens` serve qualquer usuário autenticado. O valor de um token só aparece na resposta de criação.
- **Sources e credentials**: `gateway-admin`.
- **Tools** (F1.4): leitura para `gateway-admin` e `tool-owner`. Transições e overrides para `gateway-admin` ou para o `tool-owner` cujo grupo (`users.groups`) é igual ao `owner_team` da tool.
- **Schemas**: Zod via `fastify-type-provider-zod`. Request e response são validados em runtime. O OpenAPI é gerado dos mesmos schemas e publicado em `/admin/v1/openapi.json`.
- **Erros**: `{ "error": "<CODE>", "message": "...", "details"?: ... }`, com status HTTP do catálogo do `core`.
- **Listas**: `?limit=&offset=` → `{ "items": [...], "total": n }`.
- **Crawl**: `POST /sources/:id/crawl` cria um `crawl_run` (`queued`), enfileira o job `crawl-source` na fila BullMQ `crawl` e responde `202` com o run.

## Consequências
O OpenAPI publicado é sempre consistente com a validação em runtime, o que serve de base para os testes de contrato.

## Adendo (2026-10-04): admin de tenant e admin de plataforma
O pentest de 2026-10-03 mostrou que a regra "só `gateway-admin` aponta para outro tenant" valia também para um `gateway-admin` **com** tenant, o admin do tenant (ADR-011). Esse usuário conseguia ler e alterar qualquer tenant via `X-Tenant`, além de gerir `/tenants`.

Regras a partir deste adendo:
- **Trocar de tenant via `X-Tenant`**: só o admin de plataforma (`gateway-admin` com `tenant_id` nulo).
- **Admin de tenant**: atua apenas no próprio tenant.
- **`/tenants`**:
  - criar e excluir tenant: só o admin de plataforma;
  - listar, ler e alterar: o admin de tenant enxerga e altera apenas o próprio tenant.
