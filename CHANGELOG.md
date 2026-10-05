# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). All packages share one version (ADR-019).

## [Unreleased]

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
