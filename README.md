# mcp-gateway

[![CI](https://github.com/leandro-jm/mcp-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/leandro-jm/mcp-gateway/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node ≥ 22.12](https://img.shields.io/badge/node-%E2%89%A522.12-339933)

**English** · [Português](README.pt-BR.md) · **Website:** [leandro-jm.github.io/mcp-gateway](https://leandro-jm.github.io/mcp-gateway/)

A multi-tenant **Model Context Protocol (MCP) gateway** that turns existing REST/OpenAPI APIs into governed MCP tools for AI agents, without changing the APIs themselves.

Point it at an OpenAPI spec (or a Postman collection, HAR or cURL) and it generates agent-friendly tools. Owners review and enable them, and policies decide who can call what. On every call the gateway injects upstream credentials, redacts personal data, trims responses to fit the model's context, and records a full audit and observability trail.

## Why

Connecting agents straight to internal APIs means leaking credentials into prompts, sending personal data to the model, flooding the context window with huge payloads, and having no idea what the agent actually did. mcp-gateway sits in the middle and enforces a few principles:

- **Default deny**: discovered tools start disabled; an enabled tool without a policy is still unreachable.
- **Untouched downstream**: no API needs to change.
- **Agents never see credentials**: they live only in the gateway, encrypted per tenant.
- **PII leaves masked**: redaction runs before any byte reaches the model.
- **Context is scarce**: projection, incremental discovery and artifacts are built in.
- **Everything is auditable**: one structured event per call, with no sensitive payload.

## Features

- **MCP endpoints** over Streamable HTTP:
  - `/mcp`: every tool the caller may use;
  - `/mcp/omni`: incremental discovery with `search_tools` / `get_tool_schema` / `call_tool`, for large catalogs;
  - `/mcp/s/:slug`: curated virtual servers built in the Admin UI;
  - `/mcp/observability`: the gateway's own analytics, exposed as tools.
- **API import and crawling**: OpenAPI 3.x / Swagger 2.0, Postman, HAR and cURL; drift detection on re-crawl.
- **Credential vault**: OAuth2 client credentials, password grant, API key and static bearer, injected per upstream.
- **Authorization**: opaque API tokens and users in Postgres; policies by tenant, role, group, client and tool; rate limits.
- **PII redaction**: mask, hash, drop or tokenize, with detectors for Brazilian documents (CPF, CNPJ, PIS, CEP), email, phone, payment cards and IBAN, plus field-name rules (e.g. health, salary).
- **Response projection**: include/exclude fields with JSONPath, cap arrays and bytes, and let agents ask for `_fields`.
- **Composite tools**: orchestrate several endpoints in one tool (JSONata), or describe it in natural language and let the tenant's LLM draft it (Anthropic, OpenAI or any OpenAI-compatible server).
- **Artifacts and code mode**: large responses become `artifact://` resources with partial reads, plus a generated TypeScript SDK for agents that run code.
- **Agent observability**: Prometheus metrics, OpenTelemetry traces (with `traceparent` propagation from the agent), a call explorer, session trajectories, outcome reporting and composite suggestions.
- **Admin UI** (React) in English, Portuguese and Spanish.

## Architecture

```mermaid
flowchart LR
  subgraph clients[MCP clients]
    A[AI agents<br/>Claude Code, frameworks, SDKs]
  end
  subgraph gw[apps/gateway]
    DP["Data plane<br/>/mcp · /mcp/omni · /mcp/s/:slug"]
    API["Admin API<br/>/admin/v1"]
  end
  UI[apps/admin-ui] --> API
  A -->|Bearer token| DP
  DP -->|"AuthN → policy → validate → inject credentials"| UP[(Upstream REST APIs)]
  UP -->|"redact → project → offload"| DP
  CR[apps/crawler<br/>BullMQ worker] -->|discover & generate tools| PG
  DP --- PG[(Postgres<br/>registry, audit, analytics)]
  DP --- RD[(Redis<br/>cache, rate limit, jobs)]
  DP --- S3[(S3 / MinIO<br/>artifacts)]
  API --- PG
```

Stack: Node 22, TypeScript, Fastify, the official MCP SDK, Postgres (Drizzle, optional pgvector), Redis (BullMQ), S3-compatible storage, OpenTelemetry and Vitest with Testcontainers.

## Quickstart (local development)

Requirements: **Node.js ≥ 22.12**, **pnpm 11** (`corepack enable`) and **Docker**.

```bash
git clone https://github.com/leandro-jm/mcp-gateway.git
cd mcp-gateway
pnpm install

pnpm dev:infra                               # Postgres :15432, Redis :16379, MinIO :19000/19001
cp apps/gateway/.env.example apps/gateway/.env
cp apps/crawler/.env.example apps/crawler/.env
cp apps/admin-ui/.env.example apps/admin-ui/.env

export DATABASE_URL=postgres://gateway:gateway@localhost:15432/gateway
pnpm db:migrate
pnpm db:seed                                 # dev tenant, users and a source pointing to the fake upstream

# each in its own terminal
pnpm dev                                     # gateway on http://localhost:4000
pnpm dev:upstream                            # fake HR API on http://localhost:4010 (synthetic data)
pnpm --filter @mcp-gateway/crawler dev       # crawler worker
pnpm --filter @mcp-gateway/admin-ui dev      # Admin UI on http://localhost:5180
```

Then:

1. Open http://localhost:5180 and sign in as `owner` / `owner`.
2. Crawl the `rh` source, then review and enable the generated tools and give them a policy.
3. Call them from an MCP client, for example the bundled example:

   ```bash
   MCP_GATEWAY_TOKEN=mgw_dev-agent-token-somente-para-desenvolvimento GATEWAY_URL=http://localhost:4000 \
     pnpm tsx examples/mcp-client.ts "details of employee col-00001"
   ```

   Or from Claude Code:

   ```bash
   claude mcp add --transport http mcp-gateway http://localhost:4000/mcp/omni \
     --header "Authorization: Bearer mgw_dev-agent-token-somente-para-desenvolvimento"
   ```

> [!WARNING]
> The seed users (`admin`/`admin`, `owner`/`owner`, `agente`/`agente`) and the `mgw_dev-agent-token-…` token are **for local development only**. The seed refuses to run with `NODE_ENV=production`. Production admins are created with `pnpm db:create-admin <username>`.

## Deployment

Public, multi-arch Docker images are published to Docker Hub from version tags: [`leandrojm/mcp-gateway`](https://hub.docker.com/r/leandrojm/mcp-gateway), [`leandrojm/mcp-gateway-crawler`](https://hub.docker.com/r/leandrojm/mcp-gateway-crawler) and [`leandrojm/mcp-gateway-admin-ui`](https://hub.docker.com/r/leandrojm/mcp-gateway-admin-ui) (mirrored on `ghcr.io/leandro-jm/*`). The stack in [`docker/docker-compose.prod.yml`](docker/docker-compose.prod.yml) runs with `docker compose` or as a Portainer stack. See:

- [docs/deploy.md](docs/deploy.md): production deployment (compose and Portainer, TLS, first admin, upgrades, backup, security checklist, publishing images), in pt-BR;
- [docker/prod.env.example](docker/prod.env.example): environment variables;
- [docs/observability](docs/observability): metrics, traces, Grafana dashboard and Prometheus rules.

## Connecting clients

- [Claude Code and Claude Desktop](docs/integrations/claude-code.md)
- [Generic MCP client (official SDK, curl)](docs/integrations/generico.md)
- [Client requirements and endpoints](docs/integrations/README.md)

## Repository layout

```
apps/
  gateway/        MCP data plane + Admin API (Fastify)
  crawler/        BullMQ worker: discovery, tool generation, drift
  admin-ui/       React + Vite admin console
  site/           landing page (React + Vite, GitHub Pages)
packages/
  core/           config, errors, crypto, logger (pure)
  i18n/           typed message catalogs: en, pt-BR, es (pure)
  openapi-toolgen/  OpenAPI → tool definitions (pure)
  api-import/     Postman, HAR, cURL → OpenAPI (pure)
  policy/         authorization engine (pure)
  redaction/      PII detectors and strategies (pure)
  projection/     response projection (pure)
  composition/    composite tool definition and execution (pure)
  composer/       natural-language composer prompts and linting (pure)
  call-analytics/ call event model and analytics helpers (pure)
  db/             Postgres schema, migrations, repositories
  net/            outbound HTTP with SSRF protection
  artifacts/      S3 artifact store
  testkit/        fake upstream, fixtures, Testcontainers
docs/
  decisions/      architecture decision records (pt-BR)
  roadmap.md      implementation plan (pt-BR)
```

## Documentation language

Code, the README and the community files are in English. Architecture decision records and the guides under `docs/` are in Brazilian Portuguese. Translations are welcome.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the project rules in [AGENTS.md](AGENTS.md), which AI coding agents also follow. This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for third-party attributions.
