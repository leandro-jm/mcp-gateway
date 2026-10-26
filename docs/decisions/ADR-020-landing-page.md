# ADR-020: Landing page do projeto

- Status: aceito
- Data: 2026-10-04

## Contexto
Com a publicação como open source (ADR-019), o projeto precisa de uma página pública que explique o que ele faz e ajude a divulgá-lo. Hoje só existem os READMEs. O roadmap não prevê um site.

## Decisão
**App `apps/site`**
- React 19 + Vite, o mesmo stack do Admin UI (ADR-005). O build é estático e não tem router: uma única página com âncoras.
- O app entra no `pnpm check` (lint e typecheck) como os outros apps. Não tem backend nem chamadas de rede em tempo de execução.

**Tema**
- Reaproveita os tokens do Admin UI (`tokens.css` copiado), hoje definidos pelo ADR-026: escuro por padrão, acento monocromático, Geist e Geist Mono via `@fontsource`, raios de 8 e 10px e sombra sutil.
- Seletor Sistema / Claro / Escuro, com a preferência em `localStorage` (`mcp-gw-site:theme`) aplicada antes da primeira pintura.

**i18n**
- Os mesmos três idiomas do ADR-012 (`en`, `pt-BR`, `es`), com catálogos tipados por área via `defineMessages` de `@mcp-gateway/i18n`. A paridade de chaves é garantida pelo typecheck.
- O idioma vem de `?lang=`, depois de `localStorage` (`mcp-gw-site:locale`), depois de `navigator.languages` e por fim `en`.

**Efeitos**
- Feitos só com CSS, SVG e `IntersectionObserver`, sem bibliotecas de animação.
- Com `prefers-reduced-motion: reduce`, os loops, a digitação do terminal e os contadores são desligados e o estado final aparece direto.

**Screenshots**
- As imagens do Admin UI são geradas por um script Playwright (`apps/site/scripts/capture-screens.ts`) contra o stack de dev semeado. Ele captura cada tela nos temas escuro e claro.
- As imagens ficam versionadas em `apps/site/public/screens`. O script é rodado à mão quando a UI muda.

**Publicação**
- GitHub Pages via GitHub Actions (`.github/workflows/site.yml`), com base `/mcp-gateway/`. O workflow roda em push para `main` que altere o site ou o pacote de i18n.
- Versão autocontida em um único HTML (`pnpm --filter @mcp-gateway/site build:single`), para enviar ou abrir offline. JS, CSS, fontes (só o subset latino em woff2), favicon e screenshots vão embutidos como data URIs. Os screenshots entram num mapa global consultado por `asset()`.

## Consequências
- O site acompanha o tema e os idiomas do produto sem duplicar o mecanismo de i18n.
- Os screenshots podem ficar desatualizados quando a UI muda. É preciso rodar o script de novo antes de releases que alterem telas.
- O repositório precisa de "Source: GitHub Actions" em Settings → Pages para o deploy funcionar.
