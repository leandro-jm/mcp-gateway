import type { Admin, ToolRouterView } from './admin';

type Settings = Record<string, unknown>;
const obj = (v: unknown): Settings => (v && typeof v === 'object' ? (v as Settings) : {});

export const routerView = (admin: Admin) => admin.get<ToolRouterView>('/settings/tool-router');

/** Phase 2: rerank + shortlist on, gate off, decision budget above the run's volume. Phase 1: tenant switch off. */
export async function setRouter(admin: Admin, on: boolean): Promise<void> {
  const { settings } = await routerView(admin);
  const next: Settings = on
    ? {
        ...settings,
        enabled: true,
        maxDecisionsPerMinute: Math.max(Number(settings.maxDecisionsPerMinute ?? 0), 6000),
        rerank: { ...obj(settings.rerank), enabled: true },
        shortlist: { ...obj(settings.shortlist), enabled: true },
        gate: { ...obj(settings.gate), enabled: false },
      }
    : { ...settings, enabled: false };
  await admin.put('/settings/tool-router', next);
}

export const putRouterSettings = (admin: Admin, settings: Settings) => admin.put('/settings/tool-router', settings);
