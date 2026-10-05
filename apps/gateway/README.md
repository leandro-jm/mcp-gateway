# @mcp-gateway/gateway

MCP data plane (`/mcp`, `/mcp/omni`, `/mcp/s/:slug`, `/mcp/observability`) and Admin API (`/admin/v1`), served by one Fastify process in separate modules.

Run with `pnpm dev` (port 4000). Configuration: [`.env.example`](.env.example). Build: `pnpm --filter @mcp-gateway/gateway build` (tsup → `dist/main.js` and `dist/migrate.js`).

Part of the [mcp-gateway](../../README.md) monorepo; internal and not published to npm. Licensed under [Apache-2.0](../../LICENSE).
