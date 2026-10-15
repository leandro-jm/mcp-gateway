# mcp-gateway

Multi-tenant MCP gateway that exposes REST/OpenAPI APIs as MCP tools, with policies, redaction, audit and agent observability.

Source, docs and issues: https://github.com/leandro-jm/mcp-gateway

## Images

| Image | What it runs | Port |
|---|---|---|
| `leandrojm/mcp-gateway` | Data plane (`/mcp`, `/mcp/omni`, `/mcp/s/:slug`) and Admin API (`/admin/v1`). Also runs migrations (`node dist/migrate.js up`). | 4000 |
| `leandrojm/mcp-gateway-crawler` | BullMQ worker: OpenAPI discovery, tool generation and drift detection. | none |
| `leandrojm/mcp-gateway-admin-ui` | Admin UI (nginx), proxying `/admin`, `/mcp` and `/sdk` to the gateway. | 8080 |

All three are multi-arch (`linux/amd64`, `linux/arm64`) and share the same tags:
- `X.Y.Z` and `X.Y` for releases (`latest` points at the newest release);
- `sha-<commit>` for every published build.

## Run it

The stack (gateway, crawler, admin-ui, Postgres with pgvector, Redis, MinIO and a one-shot `migrate` job) is defined in [`docker/docker-compose.prod.yml`](https://github.com/leandro-jm/mcp-gateway/blob/main/docker/docker-compose.prod.yml). It works with `docker compose` and as a Portainer stack.

```bash
curl -fsSLO https://raw.githubusercontent.com/leandro-jm/mcp-gateway/main/docker/docker-compose.prod.yml
curl -fsSL https://raw.githubusercontent.com/leandro-jm/mcp-gateway/main/docker/prod.env.example -o .env
# edit .env: PUBLIC_URL, POSTGRES_PASSWORD, GATEWAY_MASTER_KEY, S3_SECRET_KEY, METRICS_TOKEN, SETUP_TOKEN
docker compose -f docker-compose.prod.yml --env-file .env up -d
```

Open the Admin UI (port 8080): on a fresh instance it shows a setup screen that asks for `SETUP_TOKEN` and creates the platform admin and the first tenant. Without `SETUP_TOKEN`, create the admin with `docker compose -f docker-compose.prod.yml exec gateway node dist/migrate.js create-admin admin`.

Full guide (variables, TLS, Portainer, upgrades, backups): [`docs/deploy.md`](https://github.com/leandro-jm/mcp-gateway/blob/main/docs/deploy.md).

## License

Apache-2.0
