import { BarChart, GraphChart, LineChart, ScatterChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';

/**
 * The only module that loads ECharts (ADR-028): it registers just what the charts use, so the
 * bundle carries no unused series. Adding a chart type means registering it here.
 */
echarts.use([BarChart, LineChart, ScatterChart, GraphChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, MarkLineComponent, SVGRenderer]);

export { echarts };
export type { ECharts } from 'echarts/core';
