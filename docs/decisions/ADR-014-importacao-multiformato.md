# ADR-014: Importação de APIs a partir de cURL, Postman e HAR

- Status: aceito
- Data: 2026-10-04

## Contexto
Hoje uma source só é criada de dois jeitos: com `openapi_url` ou com `openapi_inline` (objeto JSON). Muitas APIs de clientes não publicam OpenAPI. O que existe costuma ser:
- um cURL na documentação;
- uma coleção Postman;
- uma gravação do navegador (HAR).

O owner precisa colar, subir ou apontar qualquer um desses formatos e ver as tools que seriam geradas **antes** de salvar. Também precisa poder mesclar operações novas numa source que já existe.

Restrições que já valem:
- O pipeline `parseSpec` → `generateTools` → `registerTools` (F2), com drift e default deny, não deve ganhar caminhos paralelos.
- O ADR-003 cobre o SSRF no download (T1) e a spec maliciosa (T11).
- Nada de PII ou credencial em logs ou no banco além do previsto.

## Decisão
1. **Tudo vira OpenAPI 3.1.** Um pacote puro novo, `packages/api-import`, converte cURL, Postman (coleções v2.0 e v2.1) e HAR 1.2 para um documento OAS 3.1. O OpenAPI colado como texto (JSON ou YAML) passa direto. O `NormalizedSpec` e o `specVersion` do toolgen não mudam.
2. **Persistência.**
   - Entrada colada ou enviada como arquivo, em qualquer formato: o OAS gerado vai para `openapi_inline`. O texto original **nunca** é persistido.
   - URL de coleção Postman: vai para `openapi_url` com `spec_format = 'postman'` (coluna nova em `upstream_sources`). O crawler reconverte a coleção a cada crawl, então o drift continua funcionando.
   - URL OpenAPI: segue como hoje (`spec_format = 'openapi'`).
   - A coluna `import_meta` (jsonb) guarda só metadados de exibição: formato, data, número de operações e número de merges.
3. **Sem exemplos no OAS gerado.** HAR e exemplos do Postman carregam dados reais (PII) e tokens. Os schemas são inferidos com `inferSchema`, e os valores são descartados. Credenciais encontradas são tratadas assim:
   - O que a entrada traz como credencial (`Authorization`, cookies, headers e query de API key conhecidos, `curl -u`, `auth` do Postman) é removido.
   - No lugar, o importador declara o security scheme correspondente e devolve uma *sugestão* de tipo de credencial, sem o valor.
4. **Merge** em source existente é permitido apenas quando a spec da source é inline. O merge é feito por `METHOD path` e tem dois modos:
   - `add`: em conflito, mantém o que já existe e reporta o conflito;
   - `replace`: substitui a operação existente.

   As mudanças chegam ao registry pelo crawl normal, o que gera os drift events de sempre.
5. **Preview síncrono no gateway.**
   - `POST /admin/v1/sources/import/preview` converte a entrada e gera as tools sem gravar nada.
   - `POST /admin/v1/sources/import` reconverte no servidor (a conversão é determinística, então não há token de preview), grava e enfileira o crawl.

   O download por URL usa o mesmo `fetchSpec`, que sai do crawler para `packages/net`. Assim valem o `outboundFetch`, a allowlist por tenant, a proibição de redirects e os limites de bytes e timeout.
6. **Limites (T11).**
   - Por import: no máximo 500 operações e 5.000 entradas de HAR.
   - Os nós dos schemas inferidos ficam limitados, além do `MAX_EXPANDED_NODES` e do `MAX_SCHEMA_NODES` que já existem.
   - O body das rotas de import tem `bodyLimit` próprio (`IMPORT_MAX_BYTES`, 10 MB por padrão, alinhado a `SPEC_MAX_BYTES`).
   - O body dessas rotas não é logado.
7. **Heurística de path template** (cURL e HAR): segmentos numéricos, UUIDs, hex com 16 ou mais caracteres, ULIDs, ids com prefixo (`col-00001`) e tokens longos viram `{<recurso no singular>_id}` (`/colaboradores/col-00001` → `/colaboradores/{colaborador_id}`). Placeholders explícitos (`{id}`, `{{id}}`, `:id`) são mantidos. O preview mostra o template, e o owner pode corrigir o OAS (`GET /sources/:id/openapi` + `PATCH`).

## Consequências
- O toolgen, o registro, o drift e o proxy não mudam. Qualquer formato novo é só um conversor a mais em `api-import`.
- Converter para OAS perde o que o OpenAPI não expressa (scripts e testes do Postman, GraphQL). Esses casos viram warnings no preview, e a operação é pulada.
- **Risco aceito**: o preview roda no event loop do gateway. Fica mitigado pelos limites de tamanho e de nós. Se o p95 da Admin API piorar, o preview passa a ser um job do crawler.
- **Risco aceito**: a heurística de path pode errar (por exemplo, com slugs textuais). Fica mitigado pelo preview obrigatório na UI e pela edição do OAS.
- Uma URL de share do Postman com `access_key` na query fica gravada em `openapi_url`. A UI recomenda usar uma credencial `api_key` (`X-Api-Key`) em vez disso.
