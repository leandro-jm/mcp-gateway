import { useMemo } from 'react';
import { useT } from '../../i18n';
import { ChartFrame, chartLabel } from './ChartFrame';
import { EChart } from './EChart';
import { swimlaneOption, type SwimlaneInput } from './options/relations';
import { useBuildCtx } from './useBuildCtx';

/** Steps over lanes (e.g. a session's calls per tool). Clicking a point picks that step. */
export function Swimlane({
  title,
  desc,
  points,
  groups,
  current,
  onPick,
  laneLabel,
  groupLabel,
}: {
  title: string;
  desc?: string;
  points: SwimlaneInput['points'];
  groups: SwimlaneInput['groups'];
  current: number;
  onPick(step: number): void;
  laneLabel: string;
  groupLabel: string;
}) {
  const t = useT();
  const ctx = useBuildCtx();
  const stepLabel = t('charts.step');
  const option = useMemo(() => swimlaneOption({ points, groups, current, stepLabel }, ctx), [points, groups, current, stepLabel, ctx]);
  const lanes = new Set(points.map((p) => p.lane)).size;
  const groupName = new Map(groups.map((g) => [g.id, g.label]));
  return (
    <ChartFrame
      title={title}
      table={{ columns: [t('charts.colStep'), laneLabel, groupLabel, t('charts.colValue')], rows: points.map((p, i) => [i + 1, p.lane, groupName.get(p.group) ?? p.group, p.tip]) }}
      empty={!points.length}
    >
      <EChart
        option={option}
        merge
        height={lanes * 30 + (points.length > 40 ? 90 : 60)}
        label={chartLabel(title, desc)}
        events={{
          click: (raw) => {
            const v = (raw as { data?: { value?: number[] } }).data?.value;
            if (v && v[2] !== undefined) onPick(v[2]);
          },
        }}
      />
    </ChartFrame>
  );
}
