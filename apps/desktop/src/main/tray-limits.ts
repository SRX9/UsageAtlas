import type { DashboardSnapshot } from "@usageatlas/contracts";
import { trayLimitEntries, type TrayLimitPreferences } from "../shared/capacity-model";

export function trayLimitLabels(
  snapshot: DashboardSnapshot,
  limitOrder: string[],
  trayLimits: TrayLimitPreferences = {}
): string[] {
  return trayLimitEntries(snapshot.providers, limitOrder, trayLimits).map(({ provider, window }) => (
    `${provider.name} - ${window.label}: ${Math.round(clampPercent(window.remainingPercent))}% available`
  ));
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
