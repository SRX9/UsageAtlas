import type { DashboardState } from "../shared/desktop-api";
import { snapshotHasCachedUsage } from "../shared/cached-snapshot";

export const initialDashboardState: DashboardState = {
  revision: -1, snapshot: null, refreshing: true, progress: null, error: null
};

export function latestDashboardState(current: DashboardState, incoming: DashboardState): DashboardState {
  return incoming.revision > current.revision ? incoming : current;
}

export function dashboardIsLoading(state: DashboardState): boolean {
  return state.refreshing && (!state.snapshot || !snapshotHasCachedUsage(state.snapshot));
}

export function dashboardFailure(state: DashboardState): string | null {
  if (state.error) return state.error;
  if (state.refreshing || !state.snapshot || snapshotHasCachedUsage(state.snapshot)) return null;
  const enabled = state.snapshot.providers.filter(provider => provider.enabled);
  if (enabled.length === 0) return null;
  const allFailed = enabled.every(provider => provider.error &&
    (!provider.analytics || provider.analytics.status === "unavailable"));
  return allFailed ? "Usage could not be loaded. Check your connection and try again." : null;
}
