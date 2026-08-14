import fixtureSnapshot from "@usageatlas/contracts/fixtures/dashboard-v2.json";
import type { DashboardSnapshot } from "@usageatlas/contracts";
import { describe, expect, it } from "vitest";
import {
  baselinePercent,
  buildBaseline,
  buildPeriodUsage,
  costPresentation,
  percentageChange,
  periodBounds,
  previousPeriod,
  shiftDay,
  tokenComposition
} from "./personal-analytics";

describe("personal analytics", () => {
  const snapshot = fixtureSnapshot as unknown as DashboardSnapshot;

  it("builds an honest provider-scoped day", () => {
    const day = buildPeriodUsage(snapshot, "all", "2026-07-17", "2026-07-17");
    expect(day.totals).toMatchObject({ totalTokens: 720, requests: 1 });
    expect(day.providerRows[0]).toMatchObject({ id: "codex", totals: { totalTokens: 720 } });
    expect(day.coveredDays).toBe(1);
  });

  it("fills covered zero days without treating uncovered history as covered", () => {
    const period = buildPeriodUsage(snapshot, "codex", "2026-07-15", "2026-07-17");
    expect(period.days.map((day) => day.totalTokens)).toEqual([0, 1080, 720]);
    expect(period.days.every((day) => day.covered)).toBe(true);

    const outside = buildPeriodUsage(snapshot, "codex", "2026-04-18", "2026-04-18");
    expect(outside.days[0]).toMatchObject({ covered: false, totalTokens: 0 });
  });

  it("uses collected coverage for all-available bounds", () => {
    expect(periodBounds(snapshot, "all", "2026-07-17", "all")).toEqual({
      startDay: "2026-04-19",
      endDay: "2026-07-17"
    });
  });

  it("calculates baseline language inputs", () => {
    const baseline = buildBaseline(snapshot, "codex", "2026-07-17", 1);
    expect(baseline).toMatchObject({ days: 1, averageTokens: 1080, averageRequests: 2 });
    expect(baselinePercent(720, baseline.averageTokens)).toBe(67);
  });

  it("builds non-overlapping previous periods", () => {
    const period = buildPeriodUsage(snapshot, "all", "2026-07-11", "2026-07-17");
    expect(previousPeriod(period)).toEqual({ startDay: "2026-07-04", endDay: "2026-07-10" });
    expect(shiftDay("2026-07-01", -1)).toBe("2026-06-30");
    expect(percentageChange(120, 100)).toBe(20);
  });

  it("keeps token composition mutually exclusive", () => {
    expect(tokenComposition({
      inputTokens: 600,
      cachedInputTokens: 300,
      cacheCreationInputTokens: 100,
      outputTokens: 200,
      totalTokens: 1_200,
      requests: 1,
      estimatedCostUSD: 1,
      unpricedTokens: 0
    })).toEqual({ freshInput: 600, cacheRead: 300, cacheCreated: 100, output: 200 });
  });

  it("hides period cost when that provider's scan suppressed cost", () => {
    const partial = structuredClone(snapshot);
    const analytics = partial.providers[0]?.analytics;
    if (!analytics) throw new Error("Analytics fixture is missing.");
    analytics.status = "partial";
    analytics.totals.estimatedCostUSD = null;
    analytics.today.estimatedCostUSD = null;
    for (const day of analytics.daily) day.estimatedCostUSD = null;
    analytics.error = {
      code: "analytics_partial",
      message: "Some history was skipped.",
      retryable: true
    };
    const period = buildPeriodUsage(partial, "codex", "2026-07-17", "2026-07-17");
    expect(period.totals.estimatedCostUSD).toBeNull();
    expect(period.partialProviders).toEqual(["Codex"]);
    expect(costPresentation(period)).toMatchObject({
      label: "Cost estimate",
      unavailableReason: expect.stringContaining("Codex")
    });
  });

  it("keeps priced tools visible when another provider is partial or unpriced", () => {
    const mixed = structuredClone(snapshot);
    const codex = mixed.providers[0]?.analytics;
    const claude = mixed.providers[1];
    if (!codex || !claude) throw new Error("Analytics fixture is missing.");
    claude.analytics = {
      ...codex,
      status: "available",
      totals: { ...codex.today, estimatedCostUSD: 1.25, unpricedTokens: 0 },
      today: { ...codex.today, estimatedCostUSD: 1.25, unpricedTokens: 0 },
      daily: [{ date: "2026-07-17", ...codex.today, estimatedCostUSD: 1.25, unpricedTokens: 0 }]
    };
    codex.status = "partial";
    for (const day of codex.daily) day.estimatedCostUSD = null;

    const period = buildPeriodUsage(mixed, "all", "2026-07-17", "2026-07-17");
    expect(period.partialProviders).toEqual(["Codex"]);
    expect(period.totals.estimatedCostUSD).toBeCloseTo(1.25);
    expect(costPresentation(period)).toMatchObject({
      label: "API-rate estimate",
      unavailableReason: null,
      detail: expect.stringContaining("Codex history is partial")
    });
  });

  it("shows a priced subtotal when some tokens still lack a list price", () => {
    const unpriced = structuredClone(snapshot);
    const analytics = unpriced.providers[0]?.analytics;
    if (!analytics) throw new Error("Analytics fixture is missing.");
    analytics.totals.unpricedTokens = 31_800_000;
    analytics.today.unpricedTokens = 31_800_000;
    for (const day of analytics.daily) {
      if (day.date === "2026-07-17") day.unpricedTokens = 31_800_000;
    }
    const period = buildPeriodUsage(unpriced, "codex", "2026-07-17", "2026-07-17");
    expect(period.totals.estimatedCostUSD).toBeCloseTo(0.0022);
    expect(period.totals.unpricedTokens).toBe(31_800_000);
    expect(costPresentation(period)).toMatchObject({
      unavailableReason: null,
      detail: expect.stringContaining("tokens have no list price")
    });
  });
});
