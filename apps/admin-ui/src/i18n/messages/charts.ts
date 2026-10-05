import { defineMessages } from '@mcp-gateway/i18n';

/** Chart primitives (ADR-018): accessibility labels and the table fallback. */
export const charts = defineMessages('charts', {
  en: {
    'charts.showTable': 'Show as table',
    'charts.showChart': 'Show as chart',
    'charts.noData': 'No data in this period',
    'charts.colLabel': 'Item',
    'charts.colValue': 'Value',
    'charts.colTime': 'Time',
    'charts.total': 'Total',
  },
  'pt-BR': {
    'charts.showTable': 'Ver como tabela',
    'charts.showChart': 'Ver como gráfico',
    'charts.noData': 'Sem dados neste período',
    'charts.colLabel': 'Item',
    'charts.colValue': 'Valor',
    'charts.colTime': 'Horário',
    'charts.total': 'Total',
  },
  es: {
    'charts.showTable': 'Ver como tabla',
    'charts.showChart': 'Ver como gráfico',
    'charts.noData': 'Sin datos en este período',
    'charts.colLabel': 'Ítem',
    'charts.colValue': 'Valor',
    'charts.colTime': 'Hora',
    'charts.total': 'Total',
  },
});
