import { useMemo } from 'react';
import { EChart } from './EChart';
import { sparklineOption } from './options/time';
import { useBuildCtx } from './useBuildCtx';

/** Stat-tile trend: the number next to it carries the meaning; hover reads each bucket. */
export function Sparkline({ values, labels, format, label, height = 36 }: { values: number[]; labels?: string[]; format?: (v: number) => string; label: string; height?: number }) {
  const ctx = useBuildCtx();
  const option = useMemo(() => sparklineOption({ values, labels, format }, ctx), [values, labels, format, ctx]);
  if (values.length < 2) return null;
  return <EChart option={option} height={height} label={label} />;
}
