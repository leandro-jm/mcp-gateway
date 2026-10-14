# Deploy do MCP Gateway numa VPS (do zero)

Este guia sobe a stack de produção ([`docker/docker-compose.prod.yml`](../docker/docker-compose.prod.yml)) numa VPS com Docker, via linha de comando ou como **stack do Portainer**. Os serviços:

| Serviço | Imagem | Porta |
|---|---|---|
| `gateway` | `leandrojm/mcp-gateway` | 4000 (data plane `/mcp…` e Admin API `/admin/v1`) |
| `crawler` | `leandrojm/mcp-gateway-crawler` | — (worker) |
| `admin-ui` | `leandrojm/mcp-gateway-admin-ui` | 8080 (UI + proxy para o gateway) |
| `migrate` | imagem do gateway, `node dist/migrate.js up` | job one-shot |
| `postgres` | `pgvector/pgvector:pg17` | interno |
| `redis` | `redis:7-alpine` | interno |
| `minio` | `minio/minio` | interno (artefatos) |

As imagens são **públicas no Docker Hub** e multi-arch (`linux/amd64` e `linux/arm64`), com as tags `X.Y.Z`, `X.Y`, `latest` e `sha-<commit>`. As mesmas imagens também saem no GHCR (`ghcr.io/leandro-jm/mcp-gateway…`): basta usar `IMAGE_NAMESPACE=ghcr.io/leandro-jm`.

Usuários, senhas e tokens ficam no próprio Postgres (ADR-011): não há IdP externo.

## 1. Pré-requisitos
- VPS Linux (ex.: Ubuntu 24.04) com 2 vCPU, 4 GB de RAM e 40 GB de disco no mínimo.
- Docker Engine 24+ com Compose v2 (`docker compose version`). Opcional: Portainer CE.
- Dois nomes DNS apontando para a VPS, por exemplo `mcp.empresa.com` (gateway) e `mcp-admin.empresa.com` (UI).
- Um reverse proxy com TLS na frente (Caddy, Traefik ou nginx). Exemplo com Caddy no passo 6.
- Nenhum login em registry: as imagens são públicas. Só é preciso `docker login` se você publicar num namespace privado seu (passo 11).

## 2. Identidades (usuários e tokens)
O gateway autentica com **tokens opacos** guardados no Postgres (só o hash SHA-256). Há dois tipos de usuário:
- `human`: entra na Admin UI com usuário e senha e recebe um token de sessão (`AUTH_SESSION_TTL_HOURS`).
- `service`: agente ou consumidor (ex.: um orquestrador de agentes). Não tem senha; usa tokens de API gerados na Admin UI.

Roles: `gateway-admin`, `tool-owner`, `agent` e `analytics-reader` (leitura de analytics e MCP de observabilidade, F15). Owners precisam do grupo igual ao `owner_team` das sources (ex.: `team-rh`). O primeiro admin é criado no passo 7.

## 3. Variáveis
Copie [`docker/prod.env.example`](../docker/prod.env.example) para `.env` (ou cadastre as variáveis na stack do Portainer):

| Variável | Obrigatória | Descrição |
|---|---|---|
| `TAG` | sim | Versão das imagens. Fixe uma release (ex.: `0.1.0`) em vez de `latest`, para um redeploy não trocar a versão sem você saber. |
| `IMAGE_NAMESPACE` | não | Namespace das imagens. Padrão `leandrojm` (Docker Hub); `ghcr.io/leandro-jm` para o GHCR ou o seu namespace, se publicar as suas imagens. Substitui o antigo `IMAGE_PREFIX`. |
| `PUBLIC_URL` | sim | URL pública do gateway (ex.: `https://mcp.empresa.com`). Aparece na documentação da API e nos snippets de conexão. |
| `POSTGRES_PASSWORD` | sim | Senha do Postgres. |
| `GATEWAY_MASTER_KEY` | sim | `openssl rand -base64 32`. **Guarde num cofre: sem ela as credenciais dos upstreams não podem ser decifradas.** |
| `S3_SECRET_KEY` | sim | Senha do MinIO (artefatos). |
| `AUTH_SESSION_TTL_HOURS` | não | Validade da sessão da Admin UI. Padrão 12. |
| `AUTH_LOGIN_RATE_LIMIT` | não | Tentativas de login por usuário + IP a cada 5 min. Padrão 10. |
| `NETWORK_ALLOW_PRIVATE` | não | **Mantenha `false`** (SSRF, ADR-003). Use `true` só se os upstreams estiverem em rede privada; nesse caso, configure também a allowlist do tenant (`settings.network.allowedHosts`). |
| `METRICS_TOKEN` | recomendada | Protege `/metrics` com Bearer. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | não | Traces OpenTelemetry (ex.: `http://otel-collector:4318`). |
| `EMBEDDINGS_URL`, `EMBEDDINGS_API_KEY` | não | Busca híbrida no Omni (API compatível com `POST /embeddings`). |
| `AUDIT_RETENTION_MONTHS` | não | Padrão 12. |
| `CALL_EVENTS_RETENTION_DAYS` | não | Retenção dos eventos brutos de chamada (`call_events`, partições diárias). Padrão 30. |
| `CALL_ROLLUPS_RETENTION_DAYS` | não | Retenção dos agregados que alimentam os dashboards. Padrão 400. |
| `CALL_EVENTS_FLUSH_MS`, `CALL_EVENTS_BATCH_SIZE`, `CALL_EVENTS_BUFFER_MAX` | não | Writer em lote dos eventos (padrões 1000, 500 e 20000). Eventos descartados aparecem em `mcp_call_events_dropped_total`. |
| `SUBJECT_INDEX_RETENTION_MONTHS` | não | Retenção do índice de titulares LGPD (ADR-017). Padrão 12. |
| `DEBUG_CAPTURE_ENABLED` | não | Habilita a captura de debug de payloads (cifrada, 24 h, só `gateway-admin`). **Padrão `false`.** Exige S3. |
| `DEBUG_CAPTURE_MAX_MINUTES`, `DEBUG_CAPTURE_RETENTION_HOURS` | não | Duração máxima de uma captura (60) e retenção dos itens (24). |
| `TRACE_UI_URL_TEMPLATE` | não | Link do explorador de chamadas para a UI de traces (ex.: `https://jaeger.empresa.com/trace/{traceId}`). |
| `GATEWAY_PORT`, `ADMIN_UI_PORT` | não | Portas publicadas no host (padrão 4000 e 8080). |

## 4. Subir a stack

**Linha de comando**
```bash
mkdir -p /opt/mcp-gateway && cd /opt/mcp-gateway
curl -fsSLO https://raw.githubusercontent.com/leandro-jm/mcp-gateway/main/docker/docker-compose.prod.yml
curl -fsSL https://raw.githubusercontent.com/leandro-jm/mcp-gateway/main/docker/prod.env.example -o .env
vi .env                                      # passo 3
docker compose -f docker-compose.prod.yml --env-file .env up -d --wait
```

**Portainer** (CE ou BE, *Stacks → Add stack*). Escolha um dos modos:
- **Web editor**:
  1. Cole o conteúdo de `docker-compose.prod.yml`.
  2. Em *Environment variables*, use *Load variables from .env file* com o `prod.env.example` preenchido, ou cadastre as variáveis do passo 3 uma a uma.
  3. Clique em *Deploy the stack*.
- **Repository** (o repositório é público, então não precisa de credencial):
  - *Repository URL*: `https://github.com/leandro-jm/mcp-gateway`
  - *Repository reference*: `refs/heads/main` ou a tag da versão, por exemplo `refs/tags/v0.1.0`
  - *Compose path*: `docker/docker-compose.prod.yml`
  - Cadastre as variáveis em *Environment variables*.
  - *GitOps updates* (polling ou webhook) é opcional: redeploya a stack quando o compose muda no repositório.
- **Webhook para trocar de versão**:
  - Na stack, habilite *Webhook* e copie a URL.
  - Um `POST <url>?TAG=0.2.0` redeploya a stack com a nova tag; a variável da query sobrescreve a da stack.
  - O workflow `deploy` (passo 8) usa esse webhook.

Para o Portainer o nome da stack vem da UI; a chave `name:` do compose só vale na linha de comando.

O serviço `migrate` aplica as migrations e termina. `gateway` e `crawler` só sobem depois dele (`service_completed_successfully`). O bucket de artefatos é criado pelo gateway no boot.

## 5. Verificar
```bash
curl -s http://127.0.0.1:4000/healthz      # {"status":"ok"}
curl -s http://127.0.0.1:4000/readyz       # postgres, redis e s3 = "ok"
curl -s http://127.0.0.1:8080/healthz      # admin-ui
docker compose -f docker-compose.prod.yml logs -f gateway crawler
```

## 6. TLS e domínios (exemplo com Caddy)
```caddyfile
mcp.empresa.com {
  reverse_proxy 127.0.0.1:4000
}
mcp-admin.empresa.com {
  reverse_proxy 127.0.0.1:8080
}
```
Respostas MCP são JSON (stateless) e o modo Omni dinâmico usa SSE. Caddy e Traefik já fazem streaming sem buffer. No nginx, use `proxy_buffering off`. Com **várias réplicas** do gateway, o modo Omni dinâmico exige afinidade por `mcp-session-id` (ADR-009). O modo padrão não exige.

## 7. Primeiro admin, tenant e source
Crie o admin de plataforma (sem tenant; escolhe o tenant pelo header `X-Tenant`). A senha gerada é impressa uma única vez:
```bash
docker compose -f docker-compose.prod.yml --env-file .env exec gateway node dist/migrate.js create-admin admin
```
No **Portainer**:
1. Abra *Containers → `<stack>-gateway-1` → Console*.
2. Conecte com `/bin/sh` e rode `node dist/migrate.js create-admin admin`.

Use o container `gateway`: o `migrate` termina logo depois de aplicar as migrations e não tem console.
Faça login e crie o primeiro tenant:
```bash
API=https://mcp.empresa.com/admin/v1
TOKEN=$(curl -s -X POST $API/auth/login -H 'content-type: application/json' -d '{"username":"admin","password":"<senha>"}' | jq -r .token)
H="Authorization: Bearer $TOKEN"
curl -X POST $API/tenants -H "$H" -H 'content-type: application/json' -d '{"slug":"cliente-x","name":"Cliente X"}'
curl -X POST $API/credentials -H "$H" -H 'x-tenant: cliente-x' -H 'content-type: application/json' \
  -d '{"name":"rh","type":"oauth2_client_credentials","config":{"tokenUrl":"https://api.cliente-x.com/oauth/token","clientId":"...","clientSecret":"..."}}'
curl -X POST $API/sources -H "$H" -H 'x-tenant: cliente-x' -H 'content-type: application/json' \
  -d '{"name":"rh","openapiUrl":"https://api.cliente-x.com/openapi.json","baseUrl":"https://api.cliente-x.com","credentialId":"<id>","ownerTeam":"team-rh","crawlSchedule":"0 */6 * * *"}'
curl -X POST $API/sources/<id>/crawl -H "$H" -H 'x-tenant: cliente-x'
```
Depois disso, tudo pela Admin UI: criar usuários (owners e agentes `service`) e tokens em **Usuários**, revisar as tools (nascem `disabled`), ajustar descrições, definir projeção e políticas, habilitar e testar no Playground.

### Composer em linguagem natural (opcional)
O Composer pode montar tools compostas a partir de uma descrição em linguagem natural (ADR-015). Para usar:
- Configure o provedor de LLM do tenant em **Configurações**. As opções são Anthropic, OpenAI ou um servidor compatível com OpenAI.
- A API key é guardada cifrada com a chave do tenant. Não existe variável de ambiente para ela.
- Uma geração pode levar até 120 s. Se houver outro reverse proxy na frente da stack, ele precisa de timeout de pelo menos 150 s em `/admin/v1/composites/generate` (o nginx da Admin UI já vem assim).
- Num servidor compatível com OpenAI, a `base_url` segue a mesma política de rede dos upstreams. Endereços privados ficam bloqueados quando `NETWORK_ALLOW_PRIVATE=false`.

## 8. Atualizações
1. O CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) publica as imagens:
   - em todo push: `sha-<commit>` e `<branch>`, no GHCR (só amd64);
   - nas tags `vX.Y.Z`: `X.Y.Z`, `X.Y`, `latest` e `sha-<commit>`, no GHCR e no Docker Hub (amd64 e arm64), e sincroniza a descrição do Docker Hub com [`docker/dockerhub/README.md`](../docker/dockerhub/README.md).
   - Para atualizar: troque `TAG` na stack (ou chame o webhook com `?TAG=`) e redeploye. O `migrate` roda antes do gateway.
2. O workflow **deploy** (manual) roda as migrations como **job separado**, com a imagem nova e `DATABASE_URL` do ambiente. Só depois chama o webhook do Portainer com a nova `TAG`.
   - Ele é um **exemplo opcional**. Para usá-lo, crie os environments `staging`/`production` no GitHub com os secrets `DATABASE_URL` e `PORTAINER_STACK_WEBHOOK`. Sem eles, o job `guard` pula o deploy, então forks não falham. Para outro orquestrador, troque o último job.
3. As migrations têm lock (advisory lock) e são idempotentes. O `migrate` da stack não reaplica nada.
4. Rollback de schema: `docker run --rm -e DATABASE_URL=... <imagem-gateway> node dist/migrate.js down 1`. Cada migration tem `down` (ADR-006).

## 9. Backup e operação
- **Postgres**: agende `pg_dump` diário. A tabela `audit_events` é particionada por mês, e partições fora da retenção são removidas pelo job de manutenção.
- **`GATEWAY_MASTER_KEY`**: guarde fora da VPS. O backup do banco sem a chave não recupera as credenciais.
- **MinIO**: artefatos são temporários (TTL padrão 24 h). Backup é opcional.
- **Observabilidade**: aponte o Prometheus para `/metrics` (com `METRICS_TOKEN`) e importe [`docs/observability/grafana-dashboard.json`](observability/grafana-dashboard.json).

## 10. Checklist de segurança
- [ ] `NETWORK_ALLOW_PRIVATE=false` (ou allowlist por tenant, se houver upstreams internos).
- [ ] Postgres, Redis e MinIO **sem** portas publicadas (como no compose).
- [ ] `METRICS_TOKEN` definido; `/metrics` fora da internet pública, se possível.
- [ ] TLS no reverse proxy (senhas e tokens trafegam em claro sem ele).
- [ ] Senha do admin criado no passo 7 guardada num cofre; tokens de agentes com nome por consumidor e revogação quando o consumidor sair.
- [ ] `gateway-admin` concedido a poucas pessoas (enxerga todos os tenants).
- [ ] Rotação periódica das credenciais dos upstreams (`PATCH /credentials/:id` invalida os tokens em cache).
- [ ] Se o Composer em linguagem natural estiver ativo: limite de gerações por hora ajustado em **Configurações** e chave do provedor de LLM com escopo e orçamento próprios.

## 11. Publicar as imagens (mantenedores)
**Pelo CI** (caminho normal):
1. Cadastre no GitHub os secrets `DOCKERHUB_USERNAME` e `DOCKERHUB_TOKEN`. O token é um Personal Access Token do Docker Hub com escopo *Read & Write*.
2. Opcional: a variável `DOCKERHUB_NAMESPACE` (padrão `leandrojm`).
3. Uma release é a tag `vX.Y.Z` com entrada no `CHANGELOG.md` (ADR-019). O push da tag dispara o job `images`.

**Da sua máquina** ([`scripts/docker-publish.sh`](../scripts/docker-publish.sh)):
```bash
docker login -u leandrojm                    # Personal Access Token como senha
pnpm docker:build                            # imagens :local na arquitetura da máquina, para testar a stack
IMAGE_NAMESPACE=leandrojm TAG=local docker compose -f docker/docker-compose.prod.yml --env-file .env up -d
pnpm docker:publish                          # build multi-arch e push: X.Y.Z, X.Y, latest e sha-<commit>
docker buildx imagetools inspect leandrojm/mcp-gateway:0.1.0
```
- A versão vem do `package.json` raiz (`VERSION=` sobrescreve).
- O script recusa uma árvore git suja (`--allow-dirty` libera) e um `pnpm-lock.yaml` com pacotes linkados de fora do repositório.
- Outras opções: `--only gateway|crawler|admin-ui`, `--no-latest`, `PLATFORMS=linux/amd64` e `DOCKERHUB_NAMESPACE=<seu-namespace>`.
- No Docker Hub, um repositório novo é criado no primeiro push com a visibilidade padrão da conta (pública em conta pessoal, salvo se você mudou em *Settings → Default privacy*). Com `DOCKERHUB_TOKEN` definido, o script cria os repositórios que faltam já como **públicos**, com descrição. Para isso o token precisa do escopo *Read, Write, Delete*: com *Read & Write* a API responde 403, o script avisa e segue, e o push cria o repositório. Se encontrar um repositório privado, avisa: a API do Hub não troca visibilidade, então é preciso mudar em *Settings* do repositório.
