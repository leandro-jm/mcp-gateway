import { useMemo } from 'react';
import { useT } from '../../i18n';
import type { BuildCtx } from './options/base';
import { useChartTheme } from './theme';

/** Theme + localized labels every option builder needs. */
export function useBuildCtx(): BuildCtx {
  const theme = useChartTheme();
  const t = useT();
  const othersLabel = t('charts.others');
  return useMemo(() => ({ theme, othersLabel }), [theme, othersLabel]);
}
