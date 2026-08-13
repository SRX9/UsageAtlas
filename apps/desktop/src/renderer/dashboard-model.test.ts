import fixtureSnapshot from "@usageatlas/contracts/fixtures/dashboard-v2.json";
import type { DashboardSnapshot } from "@usageatlas/contracts";
import { describe, expect, it } from "vitest";
import {
  buildDashboardSummary,
  buildTopProjects,
  buildUsageCalendar,
  formatReset,
  isSnapshotStale,
  sumUsageTotals,
  usageDaysForRange
} from "./dashboard-model";

describe("dashboard model", () => {
  const snapshot = fixtureSnapshot as unknown as DashboardSnapshot;

  it("summarizes connected and attention states", () => {
    const summary = buildDashboardSummary(snapshot);
    expect(summary.connectedProviders).toBe(2);
    expect(summary.attentionProviders).toBe(0);
    expect(summary.highestUsageProvider?.id).toBe("claude");
    expect(summary.todayTokens).toBe(720);
    expect(summary.totalTokens).toBe(1800);
    expect(summary.totalRequests).toBe(3);
    expect(summary.estimatedCostUSD).toBeCloseTo(0.0056);
  });

  it("builds the overview activity calendar and project ranking", () => {
    const calendar = buildUsageCalendar(snapshot);
    const projects = buildTopProjects(snapshot);

    expect(calendar).toHaveLength(365);
    expect(calendar.reduce((total, day) => total + day.totalTokens, 0)).toBe(1800);
    expect(projects[0]).toMatchObject({ label: "project-a", totalTokens: 1800, requests: 3 });
  });

  it("keeps providers without project metadata out of the project ranking", () => {
    const remote = structuredClone(snapshot);
    const analytics = remote.providers[0]?.analytics;
    if (!analytics) throw new Error("Analytics fixture is missing.");
    analytics.source = "remote_usage";
    expect(buildTopProjects(remote)).toEqual([]);
  });

  it("uses the snapshot staleness budget", () => {
    const generated = Date.parse(snapshot.generatedAt);
    expect(isSnapshotStale(snapshot, generated + 120_000)).toBe(false);
    expect(isSnapshotStale(snapshot, generated + 181_000)).toBe(true);
  });

  it("formats reset proximity", () => {
    const window = snapshot.providers[0].windows[0];
    expect(formatReset(window, Date.parse("2026-07-17T14:00:00Z"))).toBe("Resets in 1h");
  });

  it("filters and totals local usage ranges", () => {
    const analytics = snapshot.providers[0]?.analytics;
    expect(analytics).not.toBeNull();
    if (!analytics) return;
    const days = usageDaysForRange(analytics.daily, 1, analytics.coverageEnd);
    expect(days.map((entry) => entry.date)).toEqual(["2026-07-17"]);
    expect(sumUsageTotals(days)).toMatchObject({ totalTokens: 720, requests: 1 });
  });

  it("does not publish a known-cost subtotal when some tokens are unpriced", () => {
    const known = {
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 10,
      totalTokens: 110,
      requests: 1,
      estimatedCostUSD: 0.01,
      unpricedTokens: 0
    };
    expect(sumUsageTotals([
      known,
      { ...known, estimatedCostUSD: null, unpricedTokens: 110 }
    ])).toMatchObject({
      totalTokens: 220,
      estimatedCostUSD: null,
      unpricedTokens: 110
    });
  });
});
