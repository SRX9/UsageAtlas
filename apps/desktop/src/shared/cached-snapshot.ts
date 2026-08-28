import type { DashboardSnapshot } from "@usageatlas/contracts";

/** True when SQLite (or a prior refresh) already has something worth painting. */
export function snapshotHasCachedUsage(snapshot: DashboardSnapshot): boolean {
  return snapshot.providers.some((provider) => {
    if (!provider.enabled) return false;
    if (provider.windows.length > 0) return true;
    const analytics = provider.analytics;
    if (!analytics) return false;
    if (analytics.totals.totalTokens > 0 || analytics.totals.requests > 0) return true;
    return analytics.daily.some((day) => day.totalTokens > 0 || day.requests > 0);
  });
}
