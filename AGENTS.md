# AGENTS.md — mcp-gateway

Instructions for AI coding agents (Claude Code, Codex, Cursor, Copilot, Gemini CLI, …) and for humans working on this repo.

Multi-tenant MCP gateway that exposes REST/OpenAPI APIs as MCP tools. The full plan and task order live in `docs/roadmap.md` (referred to as "PLAN" in code comments and ADRs).

## Layout
- `apps/gateway`: data plane (`/mcp`, `/mcp/omni`, `/mcp/s/:slug`, `/mcp/observability`) and Admin API (`/admin/v1`), in the same process and in separate modules.
- `apps/crawler`: BullMQ worker (OpenAPI discovery, tool generation, drift).
- `apps/admin-ui`: React + Vite.
- `apps/site`: landing page (React + Vite, static, GitHub Pages; ADR-020). Strings in `apps/site/src/i18n/messages/<area>.ts` with all three locales.
- `packages/*`: internal libraries, consumed straight from source (`exports: ./src/index.ts`).
- `docs/decisions`: ADRs. A decision not covered by the roadmap needs an ADR **before** implementation.

## Commands
- `pnpm check`: ESLint + typecheck across all packages.
- `pnpm test`: unit tests (`*.test.ts`).
- `pnpm test:int`: integration tests (`*.int.test.ts`, use Testcontainers and require Docker).
- `pnpm dev:infra` / `pnpm dev:infra:down`: local Postgres, Redis and MinIO.
- `pnpm dev`: gateway in watch mode (port 4000).
- `pnpm dev:upstream`: fake HR upstream (port 4010).
- `pnpm --filter @mcp-gateway/admin-ui dev`: Admin UI (port 5180, proxies to the gateway).
- `pnpm --filter @mcp-gateway/crawler dev`: crawler worker in watch mode (needed for crawls in dev and for the import E2E).
- `pnpm --filter @mcp-gateway/admin-ui test:e2e`: UI E2E (Playwright) against the dev stack.
- `pnpm --filter @mcp-gateway/site dev`: landing page (port 5190).
- `pnpm --filter @mcp-gateway/site build:single`: the landing page as one self-contained HTML file (`apps/site/dist/mcp-gateway-landing.html`, works offline).
- `pnpm --filter @mcp-gateway/site screens`: recaptures the Admin UI screenshots used by the landing page (needs the dev stack; `SITE_URL` also renders `og.png`).
- `pnpm db:migrate` / `pnpm db:seed`: migrations and seed (require `DATABASE_URL`).
- `pnpm db:create-admin <username>`: creates a platform admin and prints the generated password (production bootstrap).
- `pnpm docker:build`: builds the three images for the native platform as `leandrojm/mcp-gateway*:local` (try them with `IMAGE_NAMESPACE=leandrojm TAG=local docker compose -f docker/docker-compose.prod.yml …`).
- `pnpm docker:publish`: builds multi-arch images and pushes them to Docker Hub (`scripts/docker-publish.sh --help`; needs `docker login`). CI publishes the same images on `v*` tags.
- `@mcp-ui-kit/*` comes from npm. To work on the kit at the same time, `pnpm link ../mcp-ui-kit/packages/<pkg>` inside the app and never commit the resulting `link:` (the image build refuses it).
- Dev ports: Postgres 15432, Redis 16379, MinIO 19000/19001.
- Seed users (ADR-011, **development only**): `admin`/`admin` (platform), `owner`/`owner`, `agente`/`agente`, and the service user `agent-dev` with the token `mgw_dev-agent-token-somente-para-desenvolvimento`.

## Rules
- **Pure packages** (`core`, `i18n`, `openapi-toolgen`, `api-import`, `policy`, `redaction`, `projection`, `composition`, `composer`, `call-analytics`) do no I/O. ESLint blocks fs/net/http/pg/redis/s3 imports in them.
- **Multi-tenant**: every repository function in `packages/db` takes an explicit `tenantId`. An architecture test enforces this.
- **Auth**: users and opaque tokens in Postgres (ADR-011). Only the SHA-256 hash of a token is stored; the value is shown exactly once.
- **No PII or credentials in logs**: use the `core` logger, which redacts sensitive keys.
- **i18n (ADR-012)**: locales `en` (default), `pt-BR` and `es`; the locale comes from `users.locale`. Every user- or agent-facing string comes from a typed catalog (`packages/i18n/src/server/<area>.ts` on the backend, `apps/admin-ui/src/i18n/messages/<area>.ts` in the UI) with all three locales. Errors use `msg(key, params)`, never a bare string. Code, comments, logs and test names are written in English; `docs/` and ADRs are written in pt-BR; `README.md` and community files are in English (ADR-019).
- **Default deny**: a tool is born `disabled`; a tool without a policy is not reachable.
- **Observability (ADR-016)**: the executor builds a single `CallEvent` per call (`telemetry/call-events`); audit, metrics, spans and `call_events` derive from it. No payloads, search queries or free text in the event. The `analytics-reader` role reads analytics and accesses `/mcp/observability`.
- Extensionless imports (`moduleResolution: bundler`). Dev runs through `tsx`; apps are built with `tsup`.
- TypeScript pinned to `~6.0` (typescript-eslint does not support TS 7 yet).
- Versioning (ADR-019): a single fixed version across all `package.json` files; releases are `vX.Y.Z` tags with a `CHANGELOG.md` entry.
- Commits: roadmap tasks use one commit per task, message `F2.3: <description>`; other contributions use [Conventional Commits](https://www.conventionalcommits.org/).
- A task is done only when `pnpm check` and `pnpm test` are green and all acceptance criteria are met.
