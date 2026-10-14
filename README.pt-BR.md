# mcp-gateway

[![CI](https://github.com/leandro-jm/mcp-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/leandro-jm/mcp-gateway/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node ≥ 22.12](https://img.shields.io/badge/node-%E2%89%A522.12-339933)

[English](README.md) · **Português** · **Site:** [leandro-jm.github.io/mcp-gateway](https://leandro-jm.github.io/mcp-gateway/?lang=pt-BR)

Um **gateway MCP (Model Context Protocol)** multi-tenant que transforma APIs REST/OpenAPI existentes em tools MCP governadas para agentes de IA, sem alterar as APIs.

Você aponta para uma spec OpenAPI (ou uma coleção Postman, HAR ou cURL) e o gateway gera tools pensadas para agentes. Os owners revisam e habilitam as tools, e as políticas definem quem pode chamar o quê. Em cada chamada, o gateway injeta as credenciais do upstream, redige dados pessoais, enxuga a resposta para caber no contexto do modelo e registra auditoria e observabilidade completas.

## Por quê

Ligar agentes direto em APIs internas significa vazar credenciais em prompts, mandar dados pessoais para o modelo, lotar a janela de contexto com payloads enormes e não saber o que o agente fez de fato. O mcp-gateway fica no meio e garante alguns princípios:

- **Default deny**: tools descobertas nascem desabilitadas; tool habilitada sem política continua inacessível.
- **Downstream intocado**: nenhuma API precisa mudar.
- **O agente nunca vê credencial**: elas ficam só no gateway, cifradas por tenant.
- **PII sai mascarada**: a redação acontece antes de qualquer byte chegar ao modelo.
- **Contexto é recurso escasso**: projeção, descoberta incremental e artefatos fazem parte do núcleo.
- **Tudo auditável**: um evento estruturado por chamada, sem payload sensível.

## Funcionalidades

- **Endpoints MCP** sobre Streamable HTTP:
  - `/mcp`: todas as tools que o chamador pode usar;
  - `/mcp/omni`: descoberta incremental com `search_tools` / `get_tool_schema` / `call_tool`, para catálogos grandes;
  - `/mcp/s/:slug`: servidores virtuais curados, montados na Admin UI;
  - `/mcp/observability`: o analytics do próprio gateway exposto como tools.
- **Importação e crawling de APIs**: OpenAPI 3.x / Swagger 2.0, Postman, HAR e cURL; detecção de drift a cada novo crawl.
- **Cofre de credenciais**: OAuth2 client credentials, password grant, API key e bearer estático, injetados por upstream.
- **Autorização**: tokens de API opacos e usuários no Postgres; políticas por tenant, role, grupo, client e tool; rate limit.
- **Redação de PII**: mask, hash, drop ou tokenize, com detectores de documentos brasileiros (CPF, CNPJ, PIS, CEP), e-mail, telefone, cartão e IBAN, além de regras por nome de campo (ex.: saúde, salário).
- **Projeção de respostas**: inclusão/exclusão de campos via JSONPath, limite de arrays e bytes, e `_fields` pedido pelo agente.
- **Tools compostas**: orquestram vários endpoints numa tool só (JSONata). Também podem ser descritas em linguagem natural e rascunhadas pela LLM do tenant (Anthropic, OpenAI ou servidor compatível com OpenAI).
- **Artefatos e code mode**: respostas grandes viram recursos `artifact://` com leitura parcial, e há um SDK TypeScript gerado para agentes que executam código.
- **Observabilidade de agentes**: métricas Prometheus, traces OpenTelemetry (com propagação de `traceparent` a partir do agente), explorador de chamadas, trajetórias de sessão, report de outcome e sugestão de compostas.
- **Admin UI** (React) em inglês, português e espanhol.

## Arquitetura

```mermaid
flowchart LR
  subgraph clients[Clientes MCP]
    A[Agentes de IA<br/>Claude Code, frameworks, SDKs]
  end
  subgraph gw[apps/gateway]
    DP["Data plane<br/>/mcp · /mcp/omni · /mcp/s/:slug"]
    API["Admin API<br/>/admin/v1"]
  end
  UI[apps/admin-ui] --> API
  A -->|Bearer token| DP
  DP -->|"AuthN → política → validação → credenciais"| UP[(APIs REST upstream)]
  UP -->|"redação → projeção → offload"| DP
  CR[apps/crawler<br/>worker BullMQ] -->|descobre e gera tools| PG
  DP --- PG[(Postgres<br/>registry, auditoria, analytics)]
  DP --- RD[(Redis<br/>cache, rate limit, jobs)]
  DP --- S3[(S3 / MinIO<br/>artefatos)]
  API --- PG
```

Stack: Node 22, TypeScript, Fastify, SDK oficial do MCP, Postgres (Drizzle, pgvector opcional), Redis (BullMQ), storage compatível com S3, OpenTelemetry e Vitest com Testcontainers.

## Quickstart (desenvolvimento local)

Requisitos: **Node.js ≥ 22.12**, **pnpm 11** (`corepack enable`) e **Docker**.

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
pnpm db:seed                                 # tenant, usuários e uma source apontando para o upstream fake

# cada um no seu terminal
pnpm dev                                     # gateway em http://localhost:4000
pnpm dev:upstream                            # API fake de RH em http://localhost:4010 (dados sintéticos)
pnpm --filter @mcp-gateway/crawler dev       # worker do crawler
pnpm --filter @mcp-gateway/admin-ui dev      # Admin UI em http://localhost:5180
```

Depois:

1. Abra http://localhost:5180 e entre como `owner` / `owner`.
2. Rode o crawl da source `rh`. Em seguida, revise e habilite as tools geradas e dê uma política a elas.
3. Chame as tools de um cliente MCP, por exemplo o exemplo incluído no repositório:

   ```bash
   MCP_GATEWAY_TOKEN=mgw_dev-agent-token-somente-para-desenvolvimento GATEWAY_URL=http://localhost:4000 \
     pnpm tsx examples/mcp-client.ts "details of employee col-00001"
   ```

   Ou pelo Claude Code:

   ```bash
   claude mcp add --transport http mcp-gateway http://localhost:4000/mcp/omni \
     --header "Authorization: Bearer mgw_dev-agent-token-somente-para-desenvolvimento"
   ```

> [!WARNING]
> Os usuários do seed (`admin`/`admin`, `owner`/`owner`, `agente`/`agente`) e o token `mgw_dev-agent-token-…` são **somente para desenvolvimento local**. O seed se recusa a rodar com `NODE_ENV=production`. Admins de produção são criados com `pnpm db:create-admin <username>`.

## Deploy

Imagens Docker públicas e multi-arch são publicadas no Docker Hub a partir das tags de versão: [`leandrojm/mcp-gateway`](https://hub.docker.com/r/leandrojm/mcp-gateway), [`leandrojm/mcp-gateway-crawler`](https://hub.docker.com/r/leandrojm/mcp-gateway-crawler) e [`leandrojm/mcp-gateway-admin-ui`](https://hub.docker.com/r/leandrojm/mcp-gateway-admin-ui) (espelhadas em `ghcr.io/leandro-jm/*`). A stack de [`docker/docker-compose.prod.yml`](docker/docker-compose.prod.yml) roda com `docker compose` ou como stack do Portainer. Veja:

- [docs/deploy.md](docs/deploy.md): deploy em produção (compose e Portainer, TLS, primeiro admin, atualizações, backup, checklist de segurança e publicação das imagens);
- [docker/prod.env.example](docker/prod.env.example): variáveis de ambiente;
- [docs/observability](docs/observability): métricas, traces, dashboard do Grafana e regras do Prometheus.

## Conectando clientes

- [Claude Code e Claude Desktop](docs/integrations/claude-code.md)
- [Cliente MCP genérico (SDK oficial, curl)](docs/integrations/generico.md)
- [Requisitos de cliente e endpoints](docs/integrations/README.md)

## Estrutura do repositório

```
apps/
  gateway/        data plane MCP + Admin API (Fastify)
  crawler/        worker BullMQ: discovery, geração de tools, drift
  admin-ui/       console de administração (React + Vite)
  site/           landing page (React + Vite, GitHub Pages)
packages/
  core/           config, erros, criptografia, logger (puro)
  i18n/           catálogos tipados: en, pt-BR, es (puro)
  openapi-toolgen/  OpenAPI → definições de tools (puro)
  api-import/     Postman, HAR, cURL → OpenAPI (puro)
  policy/         motor de autorização (puro)
  redaction/      detectores e estratégias de PII (puro)
  projection/     projeção de respostas (puro)
  composition/    definição e execução de tools compostas (puro)
  composer/       prompts e lint do composer em linguagem natural (puro)
  call-analytics/ modelo do evento de chamada e helpers de analytics (puro)
  db/             schema, migrations e repositórios Postgres
  net/            HTTP de saída com proteção contra SSRF
  artifacts/      store de artefatos em S3
  testkit/        upstream fake, fixtures, Testcontainers
docs/
  decisions/      ADRs (registros de decisão de arquitetura)
  roadmap.md      plano de implementação
```

## Idioma da documentação

O código, o README em inglês e os arquivos de comunidade estão em inglês. Os ADRs e os guias em `docs/` estão em português.

## Contribuindo

Contribuições são bem-vindas. Leia o [CONTRIBUTING.md](CONTRIBUTING.md) e as regras do projeto no [AGENTS.md](AGENTS.md), que também é lido por agentes de código. O projeto segue o [Contributor Covenant](CODE_OF_CONDUCT.md).

## Segurança

Reporte vulnerabilidades de forma privada. Veja o [SECURITY.md](SECURITY.md).

## Licença

[Apache License 2.0](LICENSE). Atribuições de terceiros estão no [NOTICE](NOTICE).
