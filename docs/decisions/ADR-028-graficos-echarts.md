# ADR-028: Gráficos com Apache ECharts no Admin UI e no mcp-ui-kit

- Status: aceito
- Data: 2026-11-04
- Substitui: ADR-018

## Contexto
O ADR-018 adotou primitivas próprias em SVG inline (`LineChart`, `BarChart`, `StackedBar`, `Histogram`, `Sparkline`, `StatCard`, `Graph`) para não aumentar o bundle nem ter de alinhar o tema de uma biblioteca. O próprio ADR já previa revisão caso os dashboards precisassem de zoom, brush ou tooltips ricos.

Os dashboards cresceram e essa necessidade apareceu:
- séries com até 720 buckets (30 dias por hora) sem zoom;
- tooltips só com `<title>` nativo;
- um grafo de co-uso com layout circular fixo;
- uma timeline de sessão feita à parte em `Sessions.tsx`.

O `ChartResult` do `@mcp-ui-kit/components`, que desenha os gráficos dos resultados de tools, tem as mesmas limitações.

Foram avaliadas as bibliotecas Recharts, Nivo, visx e Apache ECharts. As fontes são comparativos de terceiros e documentação; números de bundle foram medidos aqui.
- Recharts tem API React declarativa e aceita `var(--…)` direto no SVG, mas não tem grafo de rede nem heatmap.
- visx é um kit de baixo nível: daria o mesmo trabalho das primitivas próprias.
- Nivo tem boa aparência, mas a API é pesada em configuração e o suporte a zoom é limitado.
- O ECharts cobre com uma biblioteca só tudo o que o app usa: linha, área e barras com dataZoom, dispersão, grafo com layout de força e séries para timeline e waterfall. Também permite tree-shaking via `echarts/core`.

## Decisão
- **Apache ECharts 6.1.0**, versão fixa, sem `^`, nos dois lugares. Sem o wrapper `echarts-for-react`.
- **Só o que é usado é registrado.** No Admin UI, um único módulo (`components/charts/echarts.ts`) chama `echarts.use([...])` com:
  - as séries Bar, Line, Scatter e Graph;
  - os componentes Grid, Tooltip, Legend, DataZoom e MarkLine;
  - o `SVGRenderer`.

  Para usar um tipo novo, é preciso registrá-lo ali.
- **Renderer SVG.** O volume é pequeno, o texto fica nítido e os screenshots do Playwright ficam estáveis. Com um renderer só, o canvas fica fora do bundle.
- **Tema a partir dos tokens.**
  - `readChartTheme()` lê os tokens `--chart-1..6`, `--chart-grid`, os de texto, superfície, borda, estado e fonte com `getComputedStyle`.
  - `useChartTheme()` observa `data-theme` e `prefers-color-scheme`, então o gráfico muda de cor junto com a página, sem recarregar.
  - Nenhuma cor fica fixa no código dos gráficos.
- **Opções em funções puras.** Builders em `components/charts/options/*.ts` recebem dados, tema e formatadores, devolvem um `EChartsOption` e são testados em `options.test.ts`. Os componentes React só fazem a ligação.
- **Regras de leitura** (guia de visualização de dados):
  - um único eixo y por gráfico; duas medidas viram dois gráficos (latência e volume de chamadas);
  - cores categóricas em ordem fixa (slots 2..5 com matiz, depois os neutros 1 e 6), seguindo a entidade e não a posição no ranking;
  - cores de estado (`--success`, `--warning`, `--danger`) só quando significam estado;
  - rankings com rótulo de valor na ponta e cauda dobrada em "Outros";
  - texto do tooltip sempre escapado, porque nomes de tools e agentes são dados.
- **Paleta escura recalibrada.** No modo escuro, `--chart-2..5` passam para `#3b82f6`, `#16a34a`, `#8b5cf6` e `#d97706`. Os valores antigos ficavam acima da faixa de luminosidade para a superfície escura. A nova paleta passa no validador nas duas superfícies: faixa, croma, separação para daltonismo e contraste. O modo claro não mudou. `--chart-1` e `--chart-6` continuam neutros (ADR-026).
- **Acessibilidade.**
  - Cada gráfico tem `role="img"` com título e descrição.
  - O botão que alterna para tabela continua: é o equivalente acessível, e todo valor de tooltip está nela.
  - `prefers-reduced-motion` desliga as animações, inclusive a do layout de força.
- **Zoom sem atrapalhar a rolagem.** O zoom interno só reage a Shift + roda do mouse. Séries com mais de 48 buckets ganham um slider, e um botão desfaz o zoom.
- **mcp-ui-kit.**
  - `@mcp-ui-kit/components/echarts` exporta `EChartsResult`, um renderer de `ChartView` com `echarts` como peer opcional, no mesmo padrão de Leaflet e Mermaid.
  - O `ChartResult` em SVG continua como fallback sem dependência.
  - A view genérica `view.html` passa a usar o renderer ECharts.
  - O Admin UI passa o mesmo renderer no preview das tools, então o ECharts é carregado uma vez só.

## Consequências
- **Bundle medido** com `vite build` (minificado, e gzip entre parênteses):

  | Chunk | Antes | Depois |
  |---|---|---|
  | `charts` | 7,1 kB (2,4 kB) | 657 kB (222 kB) |
  | `index` (shell) | 292 kB | 292 kB, sem mudança |

  Só o núcleo do ECharts com o SVGRenderer já soma 399 kB (136 kB). O ECharts completo teria 1,14 MB (383 kB); o tree-shaking reduz 42%. O chunk é carregado só pelas páginas com gráfico (Observabilidade, Insights de agentes, Chamadas, Sessões), que já são lazy. O limite de aviso do Vite subiu para 700 kB por causa desse chunk.
- **Ganhos nos dashboards:**
  - tooltip com crosshair listando todas as séries;
  - zoom em séries longas e legenda clicável;
  - grafo de co-uso com layout de força, zoom, arraste e foco nos vizinhos;
  - dispersão de uso × taxa de erro que filtra a tabela;
  - adoção por agente em barras empilhadas;
  - impacto de drift e anomalias em formato antes → depois;
  - waterfall real por chamada, com o overhead do gateway mostrado à parte porque é um total e não uma etapa;
  - timeline de sessão clicável que acompanha o replay;
  - sparklines nos cards de SRE.
- **Custos:**
  - o tema depende de ler os tokens em runtime;
  - um tipo de gráfico novo exige registro em `echarts.ts`;
  - o HTML do tooltip é montado em string, e por isso o escape é obrigatório e está coberto por teste.
- O `Histogram` sem uso foi removido. `Dag.tsx`, que desenha o grafo de compostas com nós em DOM, a barra de progresso do onboarding e a landing ficam fora desta decisão.
