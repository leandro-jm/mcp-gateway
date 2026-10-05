# ADR-015: Composer em linguagem natural

- Status: aceito
- Data: 2026-10-04

## Contexto
A F7b entregou a composição de tools: uma DSL YAML/JSONata, o `validateComposite`, o executor DAG, o dry-run e o Composer YAML na UI. Escrever o YAML à mão ainda exige conhecer a DSL, o JSONata (ADR-002) e os schemas de input e output de cada tool.

A F14 permite pedir a composta em linguagem natural, por exemplo: "crie uma tool que traz o resumo do colaborador com escala atual e últimas marcações". Um LLM monta a definição sobre o catálogo do tenant.

Isso muda duas premissas:
- O ADR-013 aceitou avaliar expressões de compostas no processo principal porque elas são escritas por um owner (ator semiconfiável). Com o composer, quem escreve é um LLM.
- O LLM lê descrições de tools que vêm de specs de terceiros. Essas descrições podem trazer prompt injection.

O repo não tinha integração com LLM, só embeddings opcionais para a busca Omni (ADR-009), configurados por env.

## Decisão

1. **Configuração por tenant, feita pela Admin UI, sem env.**
   - Provider, modelo e API key ficam numa tabela dedicada, `tenant_llm_settings` (1:1 com o tenant).
   - Os providers suportados são `anthropic`, `openai` e `openai_compatible`; este último exige `base_url`.
   - A chave é cifrada com a data key do tenant (envelope encryption, o mesmo keyring das credenciais), com aad `llm-settings:<tenantId>`.
   - A chave é **write-only**: a API devolve só `hasApiKey` e os 4 últimos caracteres.
   - Só o `gateway-admin` do tenant edita; o admin de plataforma edita via `X-Tenant`.
   - Alternativas descartadas:
     - `credentials`: é o cofre dos upstreams. Usá-la exigiria um tipo novo no enum, e a chave apareceria na tela de credenciais.
     - `tenants.settings`: vai para o snapshot do registry no Redis e sai no `GET /tenants`.
2. **Clientes.**
   - Anthropic usa o SDK oficial, com `apiKey` e `baseURL` passados explicitamente. Assim as variáveis `ANTHROPIC_*` do ambiente nunca são lidas.
     - O modelo sugerido é `claude-opus-5-5`; `claude-sonnet-5-5` e `claude-haiku-4-5` aparecem na lista, e qualquer outro id pode ser digitado.
     - A saída estruturada usa `output_config.format` (JSON Schema) com `effort: medium`. O Haiku 4.5 não aceita `effort`, então ele não é enviado nesse modelo.
     - Nos modelos que aceitam, o fallback de recusa do servidor fica ligado (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). Quando o modelo recusa por política, a própria API refaz o pedido num modelo escolhido pela categoria da recusa.
   - OpenAI e compatíveis usam `fetch` por `outboundFetch`, com a política de rede do tenant: SSRF e DNS rebinding bloqueados, `redirect: 'error'` e corpo limitado.
3. **Saída estruturada portável.**
   - O LLM devolve um envelope pequeno: `{definition_yaml, explanation, assumptions, unsupported}`.
   - O `compositeSchema` tem campos `record<unknown>` (`args`, `input`), que os modos estritos de JSON Schema dos providers não aceitam. Por isso o YAML vai dentro do envelope, como texto.
   - O YAML passa por `parseComposite` e `validateComposite`, exatamente como uma composta escrita à mão.
4. **Ciclo gerar → validar → reparar**, com no máximo 2 reparos e sem estado.
   - Cada nova tentativa reenvia o pedido, o YAML anterior e os erros do validador em `en`.
   - O system prompt e o catálogo formam um prefixo estável e cacheável.
   - Se a definição continuar inválida depois dos reparos, ela volta ao usuário com os erros para edição manual.
5. **Geração síncrona**, num único `POST` com orçamento total de 120 s e abort quando o cliente desconecta.
   - A proposta é efêmera e só vira registro quando o usuário aceita.
   - Um job assíncrono (BullMQ, ADR-008) obrigaria a persistir o prompt, que pode conter PII.
6. **Guardrails.**
   - O catálogo vai ao LLM como **dado não confiável**, num bloco delimitado. Descrições são truncadas, e o system prompt manda ignorar instruções dentro desse bloco.
   - Só tools do catálogo enviado podem ser usadas.
   - Nenhum dado real vai ao LLM: só schemas de input e output, nunca resultados de dry-run nem exemplos.
   - O prompt do usuário passa pelo motor de redaction antes de sair do gateway.
   - Definições geradas passam por um lint extra. São rejeitadas e voltam ao ciclo de reparo quando têm:
     - funções JSONata caras ou dinâmicas (`$eval`, `$pad`);
     - um nome que colide com uma tool existente;
     - uma tool fora do conjunto de candidatos.
   - Rate limit por tenant (configurável) e por usuário.
   - A auditoria `composite.generate` registra provider, modelo, tokens, tentativas e o **hash** do prompt, nunca o texto.
7. **Humano no circuito.**
   - Nada é salvo nem habilitado automaticamente. Aceitar a proposta salva a composta pelo `POST /composites` de sempre: ela nasce `disabled`, com a checagem de time do owner.
   - O dry-run e a publicação são ações explícitas.
   - A publicação passa por um assistente com três ações: habilitar a composta, criar políticas (só admin) e incluir num virtual server.

## Consequências
- Uma composta gerada passa pelos mesmos controles de uma escrita à mão: validador, `EXPR_LIMITS`, `maxSteps`, authz por step e default deny. Ela também passa pelo lint extra.
- O risco residual do ADR-013 continua: uma expressão cara aceita por um humano. Ele fica menor, porque o lint barra as funções conhecidas e uma pessoa revisa antes de salvar.
- O custo de LLM é do tenant, pela própria chave. O consumo de tokens aparece em cada geração e na auditoria.
- A request de geração pode levar dezenas de segundos. O proxy reverso precisa de timeout de pelo menos 150 s em `/admin/v1/composites/generate`.
