# ADR-018: Gráficos na Admin UI sem biblioteca

- Status: aceito
- Data: 2026-10-04

## Contexto
A F15 traz dashboards para SRE, owner, segurança e FinOps, a timeline de sessões e o grafo de co-uso. A Admin UI não tem biblioteca de gráficos: as dependências são React, React Router e lucide-react, e o único SVG próprio é o grafo de compostas (`components/Dag.tsx`, F14.8). O tema segue tokens CSS (ADR-005), com modo claro e escuro.

## Decisão
- Primitivas próprias em SVG inline, em `apps/admin-ui/src/components/charts/`: `LineChart`, `BarChart`, `StackedBar`, `Histogram`, `Sparkline`, `StatCard` e `Graph`.
- As cores vêm dos tokens do tema (`var(--…)`) e funcionam nos dois modos. O layout usa `viewBox`, então é responsivo.
- Acessibilidade: `<title>`/`<desc>` em cada gráfico e um botão que alterna para uma tabela com os mesmos dados.
- Sem dependência nova. Recharts, visx e ECharts foram descartados pelo tamanho do bundle e pelo esforço de alinhar o tema.

## Consequências
- Bundle e tema ficam sob controle, e os gráficos seguem o mesmo padrão do `Dag.tsx`.
- Não há zoom, brush nem tooltips ricos. Se os dashboards precisarem disso, este ADR deve ser revisto.
