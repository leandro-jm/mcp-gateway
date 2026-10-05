# @mcp-gateway/db

Postgres schema (Drizzle), migrations, repositories (always with an explicit `tenantId`), the dev seed and the admin bootstrap CLI.

Scripts: `pnpm db:migrate`, `pnpm db:seed` (dev only), `pnpm db:create-admin <username>`.

Part of the [mcp-gateway](../../README.md) monorepo; internal and not published to npm. Licensed under [Apache-2.0](../../LICENSE).
