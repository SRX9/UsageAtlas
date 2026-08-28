import type { DashboardSnapshot } from "@usageatlas/contracts";
import { describe, expect, it } from "vitest";
import { snapshotHasCachedUsage } from "./cached-snapshot";

describe("snapshotHasCachedUsage", () => {
  it("is true when an enabled provider has stored usage", () => {
    expect(snapshotHasCachedUsage(snapshot({
      enabled: true,
      windows: [],
      analytics: { totals: { totalTokens: 40, requests: 1 }, daily: [] }
    }))).toBe(true);
  });

  it("is false when nothing has been stored yet", () => {
    expect(snapshotHasCachedUsage(snapshot({
      enabled: true,
      windows: [],
      analytics: null
    }))).toBe(false);
  });
});

function snapshot(provider: {
  enabled: boolean;
  windows: Array<{ kind: string; label: string; usedPercent: number; remainingPercent: number }>;
  analytics: { totals: { totalTokens: number; requests: number }; daily: Array<{ totalTokens: number; requests: number }> } | null;
}): DashboardSnapshot {
  return {
    schemaVersion: 2,
    generatedAt: "2026-07-18T00:00:00.000Z",
    staleAfterSeconds: 180,
    host: {},
    providers: [{
      id: "fixture",
      name: "Fixture",
      enabled: provider.enabled,
      source: "fixture",
      windows: provider.windows,
      identity: null,
      credits: null,
      analytics: provider.analytics
        ? {
            status: "available",
            source: "local_sessions",
            historyDays: 1,
            coverageStart: "2026-07-18",
            coverageEnd: "2026-07-18",
            updatedAt: "2026-07-18T00:00:00.000Z",
            filesScanned: 1,
            recordsProcessed: 1,
            totals: {
              inputTokens: provider.analytics.totals.totalTokens,
              cachedInputTokens: 0,
              cacheCreationInputTokens: 0,
              outputTokens: 0,
              totalTokens: provider.analytics.totals.totalTokens,
              requests: provider.analytics.totals.requests,
              estimatedCostUSD: null,
              unpricedTokens: 0
            },
            today: {
              inputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationInputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              requests: 0,
              estimatedCostUSD: null,
              unpricedTokens: 0
            },
            daily: provider.analytics.daily.map((day, index) => ({
              date: `2026-07-${String(18 - index).padStart(2, "0")}`,
              inputTokens: day.totalTokens,
              cachedInputTokens: 0,
              cacheCreationInputTokens: 0,
              outputTokens: 0,
              totalTokens: day.totalTokens,
              requests: day.requests,
              estimatedCostUSD: null,
              unpricedTokens: 0
            })),
            models: [],
            dailyModels: [],
            projects: [],
            sessions: [],
            serviceTiers: [],
            error: null
          }
        : null,
      error: null,
      updatedAt: null
    }]
  };
}
