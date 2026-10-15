# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). All packages share one version (ADR-019).

## [Unreleased]

### Added
- Landing page (`apps/site`) in English, Portuguese and Spanish, published to GitHub Pages (ADR-020).
- MCP protocol revision 2026-07-28 (stateless, per-request envelope) on every MCP endpoint, served next to 2025-era clients (ADR-021). Client name, version and capabilities from the envelope feed the call identity.
- Generative UI on tool results via MCP Apps (ADR-022): per-tool views (table, chart, card, form, confirmation plan, map, diagram) from `@mcp-ui-kit`, inferred by the crawler and activated in the Admin UI; tenant appearance (accent, chart palette, basemap) with a contrast and color-blindness gate; `ui://mcp-gateway/*` resources; destructive tools with a plan view require a one-time human confirmation from 2026-07-28 clients with UI. Playground can simulate an MCP Apps client.
- Public multi-arch (`linux/amd64`, `linux/arm64`) images on Docker Hub: `leandrojm/mcp-gateway`, `leandrojm/mcp-gateway-crawler` and `leandrojm/mcp-gateway-admin-ui`, published by CI on `v*` tags and by `pnpm docker:publish` (`scripts/docker-publish.sh`). `pnpm docker:build` builds them locally to try the production stack.
- Portainer guide in `docs/deploy.md`: web editor, Git repository and webhook modes, first admin from the container console.
- First-run setup in the Admin UI (ADR-024): on an instance without users, a setup screen guarded by the new `SETUP_TOKEN` variable creates the platform admin and the first tenant and signs in. A platform admin without tenants now gets a "create the first tenant" form instead of a dead end.
- Admin UI **Tenants** page for the platform admin: create, rename, suspend/reactivate, switch to and remove tenants.
- Admin UI **Getting started** guide (ADR-023): what the gateway is, an eight-step checklist up to the first agent call with auto-detected progress, how-to and examples for each step, optional next steps and a glossary. The home page opens it while essential steps are pending. `GET /admin/v1/me` now returns `publicUrl`.

### Changed
- MCP SDK moved from `@modelcontextprotocol/sdk` 1.x to `@modelcontextprotocol/server` / `@modelcontextprotocol/node` 2.x.
- `resources/read` of a missing or expired artifact now answers `-32602` with `data.uri` (was `-32002`), as the 2026-07-28 revision requires.
- `/mcp/omni` dynamic sessions remain available to 2025-era clients only; 2026-07-28 clients get the static mode.
- **Breaking (deploy):** the production compose now takes `IMAGE_NAMESPACE` (default `leandrojm`, Docker Hub) instead of `IMAGE_PREFIX`. GHCR images were renamed to the same scheme: `ghcr.io/leandro-jm/mcp-gateway`, `mcp-gateway-crawler` and `mcp-gateway-admin-ui` (were `ghcr.io/leandro-jm/mcp-gateway/{gateway,crawler,admin-ui}`).
- `@mcp-ui-kit/*` is consumed from npm instead of a sibling checkout, so the repo builds (and its images build) on its own.
- MinIO image: `cgr.dev/chainguard/minio` in the compose files and tests, since `minio/minio` was removed from Docker Hub.
- CI also publishes the `main` channel (`main` and `sha-<commit>` tags) to Docker Hub on every push to main, and an optional `deploy` job redeploys a Dokploy compose service through its API once the images are pushed. The production compose pulls the app images on every deploy (`pull_policy: always`), so `TAG=main` or `latest` always gets the current image.
- Admin UI top bar: the whole tenant crumb opens the switcher, and it only looks clickable when there is another tenant to switch to; the `Gateway` crumb is now a plain label.

## [0.1.0] - 2026-10-04

First public release.

### Added
- Multi-tenant registry of sources, virtual servers and tools, with an Admin API (`/admin/v1`).
- OpenAPI crawler that generates agent-friendly tools (disabled by default) and detects drift; multi-format API import.
- MCP data plane over Streamable HTTP: `/mcp`, `/mcp/omni` (incremental discovery via `search_tools` / `get_tool_schema` / `call_tool`) and self-service virtual servers at `/mcp/s/:slug`.
- Credential vault and token manager for upstreams (client credentials, password, API key, static bearer).
- Opaque API tokens and users in Postgres, plus per-tenant/role/client/tool policies with default deny.
- PII redaction engine with Brazilian detectors (CPF, CNPJ, PIS, …) and mask/hash/drop/tokenize strategies.
- Response projection (JSONPath include/exclude, array and byte limits, agent `_fields`).
- Composite tools (JSONata), manual tools and a natural-language composer backed by the tenant's LLM.
- Large responses as artifacts (`artifact://`) with partial reads, and a generated TypeScript SDK for code-mode agents.
- Agent observability: one `CallEvent` per call feeding audit, Prometheus metrics, OpenTelemetry traces and analytics; call explorer, trajectories and `/mcp/observability`.
- React Admin UI with i18n (`en`, `pt-BR`, `es`).
- Docker images for gateway, crawler and Admin UI; production compose file and deployment guide.

[Unreleased]: https://github.com/leandro-jm/mcp-gateway/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/leandro-jm/mcp-gateway/releases/tag/v0.1.0
