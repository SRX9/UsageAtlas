import type { DashboardSnapshot } from "@usageatlas/contracts";
import { previewLimitEntries } from "../shared/capacity-model";

export function trayLimitLabels(
  snapshot: DashboardSnapshot,
  providerOrder: string[],
  maximum = 4
): string[] {
  return previewLimitEntries(snapshot.providers, providerOrder, maximum).map(({ provider, window }) => (
    `${provider.name} - ${window.label}: ${Math.round(clampPercent(window.remainingPercent))}% available`
  ));
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
