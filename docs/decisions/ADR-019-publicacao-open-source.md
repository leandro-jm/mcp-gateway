# ADR-019: Publicação como open source

- Status: aceito
- Data: 2026-10-04

## Contexto
O projeto vai para um repositório público no GitHub (`leandro-jm/mcp-gateway`). Até aqui ele não tinha licença, README nem arquivos de comunidade, e todos os pacotes estavam em `0.0.0`. Além disso, havia referências a uma organização específica no contrato público e no código: o namespace da chave `_meta` de id da chamada, um snippet de configuração dedicado a um cliente interno e o prefixo do registry de imagens. As instruções para agentes de código ficavam apenas em `CLAUDE.md`, que só o Claude Code lê.

## Decisão
- **Licença:** Apache-2.0, por ser permissiva, ter cláusula explícita de patentes e ser a licença de boa parte das dependências (OpenTelemetry, AWS SDK, drizzle). Há um `NOTICE` com as atribuições de terceiros incluídas nos artefatos distribuídos, como as fontes IBM Plex (OFL-1.1) do bundle da Admin UI.
- **Versão:** uma única versão fixa e sincronizada em todos os `package.json`, começando em `0.1.0`. Releases são tags `vX.Y.Z` (o CI já publica as imagens com semver a partir delas), com `CHANGELOG.md` na raiz no formato Keep a Changelog. Os pacotes continuam `private`: os entregáveis são as imagens, e nada é publicado no npm.
- **Versão em runtime:** o `serverInfo.version` do MCP vem do `package.json` do gateway. A `info.version` da Admin API continua sendo a versão do contrato (`1.0.0`, `/admin/v1`).
- **Namespace `_meta`:** a chave de id da chamada passa a ser `io.github.leandro-jm.mcp-gateway/call-id`, no formato de prefixo DNS reverso da especificação MCP. Como o projeto ainda não teve release pública, a troca é feita sem período de compatibilidade.
- **Integrações:** o snippet dedicado ao cliente interno na Admin API e a aba correspondente na UI são removidos. Os snippets ficam restritos a clientes públicos (Claude e cliente MCP genérico).
- **Idioma:** `README.md` e os arquivos de comunidade (CONTRIBUTING, SECURITY, CODE_OF_CONDUCT) ficam em inglês, com um `README.pt-BR.md` espelhado. ADRs e `docs/` continuam em pt-BR.
- **Instruções para agentes:** `AGENTS.md` (padrão aberto lido por Codex, Cursor, Copilot, Gemini CLI etc.) é a fonte única, em inglês. O `CLAUDE.md` apenas importa esse arquivo com `@AGENTS.md`. Não usamos symlink, porque ele quebra no Windows.
- **Planejamento:** `PLAN.md` passa a ser `docs/roadmap.md`, sem referências a consumidores internos.

## Consequências
- Clientes que liam a chave antiga do `_meta` precisam passar a ler a nova.
- O `deploy.yml` vira um exemplo opcional: só roda quando o secret do webhook está configurado, então forks não falham.
- Mudanças de versão alteram todos os `package.json` de uma vez. Se algum pacote passar a ser publicado no npm, este ADR deve ser revisto, e ferramentas como Changesets passam a valer a pena.
