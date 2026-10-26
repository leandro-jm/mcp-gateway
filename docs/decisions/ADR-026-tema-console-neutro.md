# ADR-026: Tema "console neutro" no Admin UI e na landing

- Status: aceito
- Data: 2026-10-26
- Substitui: a parte visual do ADR-005 (tokens, linguagem visual e layout). A stack do ADR-005 continua valendo.

## Contexto
O ADR-005 tomou como referência o console da E2B: acento laranja, rótulos mono em caixa alta, cantos retos, sem sombras e controles altos (50px). A landing (ADR-020) copiou esses tokens.

A nova referência é o Portal da Esteira (projeto `pipeline-dev`), um console administrativo neutro e mais denso. Ele usa paleta zinc, acento monocromático, cantos arredondados e sombra sutil, além de uma sidebar com marca e grupos rotulados. O objetivo é aplicar essa linguagem ao Admin UI e à landing, para que os dois tenham a mesma cara.

## Decisão
**Tokens** (`apps/admin-ui/src/theme/tokens.css`, copiado para `apps/site/src/theme/tokens.css`)
- Os nomes dos tokens do ADR-005 continuam (`--bg`, `--surface`, `--text`, `--accent`, …); só os valores mudam. Ficam de fora os tokens de cor fixa de componente.
- Paleta escura (padrão):
  - fundo `#0b0b0c`;
  - superfícies `#141416`, `#1b1b1e` e `#232327`;
  - bordas `#26262b` e `#36363d`;
  - texto `#f4f4f5`, secundário `#a1a1aa`, terciário `#71717a`.
- Paleta clara:
  - fundo `#fafafa`;
  - superfícies `#ffffff` e `#f4f4f5`;
  - bordas `#e6e6e9` e `#d0d0d6`;
  - texto `#18181b`, secundário `#5f5f69`, terciário `#8a8a93`.
- **Acento monocromático:** quase-branco `#fafafa` no escuro e quase-preto `#18181b` no claro. Aparece no botão primário, no foco, no sublinhado da aba e no passo atual de um stepper. O item ativo da sidebar usa fundo realçado e texto em peso 600, sem cor.
- **Cores só para estado:**
  - sucesso `#5ccb8c` / `#17804a`;
  - aviso `#e8a94d` / `#a45f00`;
  - perigo `#f38a81` / `#c0342c`;
  - info (roxo) `#b69df3` / `#6b46c1`.
  - Cada uma tem fundo suave (`-dim`) para pills e alertas.
- **Tokens novos:**
  - sidebar: `--side*`;
  - `--hover`;
  - sombras: `--shadow` (cartões e botões) e `--shadow-pop` (menus, drawer, toast);
  - raios: `--radius` 8px (controles), `--radius-lg` 10px (painéis) e `--radius-pill` 6px.
- **Séries de gráfico:**
  - a primeira série é neutra (cor do texto);
  - as demais são azul, verde, roxo, âmbar e cinza.
  - A aparência por tenant do ADR-022, que vale para as views das tools, não muda.

**Tipografia**
- Geist e Geist Mono via `@fontsource`, empacotadas sem depender da rede (no lugar de IBM Plex).
- Corpo de 14px.
- Mono só para identificadores, valores técnicos e datas. Rótulos, cabeçalhos de tabela e badges deixam de usar mono e caixa alta.
- Títulos de página em 24px, peso 600, sem caixa alta.
- Os rótulos de grupo da sidebar e os "eyebrows" da landing usam caixa alta em 11px com espaçamento.

**Linguagem visual**
- Painéis com borda de 1px, raio de 10px e sombra sutil. Controles com raio de 8px e altura em torno de 34px.
- Badges viram pills com ponto colorido (`::before`), com fundo suave da cor do estado.
- Abas sublinhadas na cor do acento.
- Steppers com nós circulares: concluído em verde com check, atual com anel.
- Botão primário preenchido com o acento; secundário com borda e fundo de superfície.

**Layout do Admin UI**
- **Sidebar fixa em altura total:**
  - marca no topo: logo num quadrado com o acento, nome e subtítulo;
  - grupos rotulados: Operar, Configurar, Gerenciar;
  - rodapé com ambiente, sair e recolher.
- **Topbar só na coluna de conteúdo:**
  - breadcrumb `Tenant / Página atual`, com a página em negrito;
  - campo "Ir para… ⌘K" com cara de busca;
  - idioma e tema;
  - inbox de drift;
  - avatar com nome, papel e menu.
- **Abaixo de 960px:** a sidebar vira uma faixa horizontal com rolagem.
- O seletor de tema (Sistema / Claro / Escuro) e o padrão escuro do ADR-005 continuam.

## Consequências
- A mudança fica quase toda em CSS (`tokens.css` e `global.css`) e no `Shell`. As páginas usam as mesmas classes e os seletores dos testes (roles, ids, test ids) não mudam.
- O teste E2E de tema passa a esperar os fundos novos.
- Os screenshots da landing precisam ser recapturados.
- Sem acento colorido, o destaque de "ativo" depende de contraste e peso. Cor fica para estado, o que deixa os alertas mais visíveis.
