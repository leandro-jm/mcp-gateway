# ADR-023: Guia de primeiros passos no Admin UI

- Status: aceito
- Data: 2026-10-14

## Contexto
Quem entra no Admin UI pela primeira vez cai em `/tools`, que num tenant novo está vazio, e vê cerca de vinte itens de menu sem saber para que o gateway serve nem em que ordem configurar. O caminho até um agente fazer a primeira chamada passa por seis páginas e tem armadilhas pouco óbvias:
- a ferramenta nasce `disabled`;
- uma ferramenta habilitada sem política continua inalcançável;
- na UI, a credencial do upstream só é ligada à fonte no momento da importação;
- o `tool-owner` não cria fonte, credencial nem política.

O roadmap não prevê um onboarding.

## Decisão
**Página `/onboarding` ("Primeiros passos")**
- Primeiro item do menu, com o número de etapas pendentes ao lado (no estilo do contador do Drift).
- Seções: o que é o gateway (texto, fluxo API → ferramentas → política → agente e os cinco princípios), checklist de oito etapas, "Vá além" (servidor MCP curado, PII, projeção, composta e observabilidade) e glossário.
- Cada etapa tem por quê, como fazer (com os rótulos reais da UI), um exemplo com a API de RH de demonstração (`pnpm dev:upstream`) e um link para a página.
- A última etapa mostra os snippets do endpoint `/mcp/omni` (Claude Code, `.mcp.json` e curl), no mesmo formato de `connectionSnippets()`.

**Detecção no cliente, sem endpoint novo**
- O progresso vem dos endpoints de listagem que já existem (`/credentials`, `/sources`, `/tools`, `/policies`, `/calls`, `/me/tokens`, `/virtual-servers`, `/pii-rules` e `/composites`).
- Cada consulta respeita o papel: quem não pode ler um endpoint não o consulta.
- O Playground e o agente são distinguidos pelo `endpoint` do `CallEvent` (`playground` ou não).
- A página consulta a cada 15 s, para os checks ficarem verdes enquanto o usuário trabalha em outra aba. O shell e o redirecionamento consultam uma vez e só as etapas essenciais.
- Etapas que não dá para observar ou que podem não se aplicar (credencial, Playground, token, projeção e observabilidade) também podem ser marcadas à mão.

**Estado local**
- As marcações manuais e a opção "não abrir este guia ao entrar" ficam em `localStorage`, na chave `mcp-gw:onboarding:<tenant>:<sub>`.
- Não há migração nem estado no servidor. Trocar de navegador perde só essas preferências; o progresso detectado continua o mesmo.

**Página inicial**
- `/` abre `/onboarding` enquanto houver etapa essencial pendente e o guia não tiver sido ocultado. Caso contrário, abre `/tools`.

**`publicUrl` em `/me`**
- `GET`/`PATCH /admin/v1/me` passam a devolver `publicUrl` (`PUBLIC_URL` do gateway).
- Isso permite montar os snippets sem um servidor virtual, já que em dev a UI roda em outra origem.

## Consequências
- Sem mudança de schema nem endpoint novo; o custo é de 7 a 10 listagens leves por carga da página.
- O que é "feito" depende do que o papel pode ler. O owner, por exemplo, só vê credenciais pelas fontes que as usam.
- O checklist reflete o tenant, não a pessoa: num tenant já configurado, um usuário novo vê quase tudo verde e cai direto em `/tools`. O guia continua no menu.
- Novas etapas exigem atualizar `lib/onboarding.ts`, o catálogo `onboarding` nos três idiomas e, se um rótulo citado mudar de nome, o texto de "como fazer".
