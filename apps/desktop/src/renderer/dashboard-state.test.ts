import fixture from "@usageatlas/contracts/fixtures/dashboard-v2.json";
import type { DashboardSnapshot } from "@usageatlas/contracts";
import { describe, expect, it } from "vitest";
import { dashboardFailure, dashboardIsLoading, initialDashboardState, latestDashboardState } from "./dashboard-state";

function emptySnapshot(): DashboardSnapshot {
  const snapshot = structuredClone(fixture) as DashboardSnapshot;
  snapshot.providers = snapshot.providers.map(provider => ({ ...provider,
    windows: [], analytics: null, identity: null, credits: null, updatedAt: null,
    error: { code: "provider_not_refreshed", message: "Waiting for collection.", retryable: true }
  }));
  return snapshot;
}

describe("dashboard display state", () => {
  it("rejects old IPC replies after an account change or a newer snapshot event", () => {
    const newer = { ...initialDashboardState, revision: 12 };
    const older = { ...initialDashboardState, revision: 11, snapshot: emptySnapshot() };
    expect(latestDashboardState(newer, older)).toBe(newer);
    expect(latestDashboardState(newer, newer)).toBe(newer);
    expect(latestDashboardState(older, newer)).toBe(newer);
  });
  it("shows loading instead of zeros before first collection", () => {
    expect(dashboardIsLoading(initialDashboardState)).toBe(true);
    const state = { ...initialDashboardState, snapshot: emptySnapshot() };
    expect(dashboardIsLoading(state)).toBe(true);
    expect(dashboardFailure(state)).toBeNull();
  });
  it("keeps cached usage visible during a refresh", () => {
    expect(dashboardIsLoading({ ...initialDashboardState, snapshot: fixture as DashboardSnapshot })).toBe(false);
  });
  it("offers retry after a failed first collection instead of showing zero usage", () => {
    const snapshot = emptySnapshot();
    for (const provider of snapshot.providers)
      provider.error = { code: "network_error", message: "offline", retryable: true };
    const state = { ...initialDashboardState, snapshot, refreshing: false };
    expect(dashboardIsLoading(state)).toBe(false);
    expect(dashboardFailure(state)).toContain("try again");
  });
  it("accepts a confirmed zero result and keeps provider setup available", () => {
    const snapshot = emptySnapshot();
    for (const provider of snapshot.providers) provider.error = null;
    const state = { ...initialDashboardState, snapshot, refreshing: false };
    expect(dashboardIsLoading(state)).toBe(false);
    expect(dashboardFailure(state)).toBeNull();
    for (const provider of snapshot.providers) provider.enabled = false;
    expect(dashboardFailure(state)).toBeNull();
  });
});
