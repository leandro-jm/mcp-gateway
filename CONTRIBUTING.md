# Contributing to mcp-gateway

Thanks for your interest! Bug reports, docs fixes and pull requests are welcome.

## Before you start
- For anything beyond a small fix, open an issue first so we can agree on the approach.
- Architectural decisions live in [`docs/decisions`](docs/decisions) (ADRs, in pt-BR). A change that introduces a decision not covered by an ADR or the [roadmap](docs/roadmap.md) needs a new ADR in the same PR (copy `ADR-000-template.md`).
- Security issues: **do not open a public issue**. See [SECURITY.md](SECURITY.md).

## Development setup
Requirements: Node.js ≥ 22.12, pnpm 11 (`corepack enable`), Docker.

```bash
pnpm install
pnpm dev:infra                       # Postgres, Redis and MinIO (ports 15432, 16379, 19000/19001)
cp apps/gateway/.env.example apps/gateway/.env
cp apps/crawler/.env.example apps/crawler/.env
export DATABASE_URL=postgres://gateway:gateway@localhost:15432/gateway
pnpm db:migrate && pnpm db:seed
pnpm dev                             # gateway on :4000
pnpm dev:upstream                    # fake HR upstream on :4010
pnpm --filter @mcp-gateway/admin-ui dev   # Admin UI on :5180
```

See [AGENTS.md](AGENTS.md) for the full command list, dev ports and seed users.

## Checks
A PR is ready when these pass locally:

```bash
pnpm check      # ESLint + typecheck
pnpm test       # unit tests
pnpm test:int   # integration tests (Testcontainers, needs Docker)
```

UI changes should also run `pnpm --filter @mcp-gateway/admin-ui test:e2e` against the dev stack.

## Project rules
The rules are in [AGENTS.md](AGENTS.md). The most important ones:
- **Pure packages** (`core`, `i18n`, `policy`, `redaction`, `projection`, …) do no I/O; ESLint enforces it.
- **Multi-tenant**: every repository function in `packages/db` takes an explicit `tenantId`.
- **i18n**: user- and agent-facing text comes from the typed catalogs, in `en`, `pt-BR` and `es`.
- **No PII or credentials in logs**: use the `core` logger.
- **Default deny**: new tools start disabled; a tool without a policy is not reachable.
- Code, comments, logs and test names are in English.

## Commits and pull requests
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, …). Roadmap tasks use `F<phase>.<n>: <description>`.
- Keep PRs focused. Add or update tests, and add a line under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
- By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).

## Using AI coding agents
[AGENTS.md](AGENTS.md) holds the instructions for coding agents (Claude Code reads it through `CLAUDE.md`; Codex, Cursor, Copilot and others read it directly). Keep it up to date when you change commands or rules. You are responsible for reviewing any agent-generated code you submit.
