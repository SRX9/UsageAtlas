import fixtureSnapshot from "@usageatlas/contracts/fixtures/dashboard-v2.json";
import type { DashboardSnapshot } from "@usageatlas/contracts";
import { describe, expect, it } from "vitest";
import { buildActivitySeries } from "./activity-buckets";
import { buildPeriodUsage } from "./personal-analytics";

const snapshot = fixtureSnapshot as unknown as DashboardSnapshot;

describe("adaptive activity buckets", () => {
  it("uses real hourly buckets for a selected day", () => {
    const period = buildPeriodUsage(snapshot, "all", "2026-07-17", "2026-07-17");
    const series = buildActivitySeries(snapshot, "all", period);

    expect(series.granularity).toBe("hour");
    expect(series.buckets).toHaveLength(24);
    expect(series.buckets[11]).toMatchObject({ totalTokens: 720, requests: 1, covered: true });
    expect(series.buckets[0]).toMatchObject({ axisLabel: "12am", label: "12am" });
    expect(series.buckets.reduce((total, bucket) => total + bucket.totalTokens, 0)).toBe(720);
  });

  it("uses four-hour batches across a two-day selection", () => {
    const period = buildPeriodUsage(snapshot, "all", "2026-07-16", "2026-07-17");
    const series = buildActivitySeries(snapshot, "all", period);

    expect(series.granularity).toBe("four-hour");
    expect(series.buckets).toHaveLength(12);
    expect(series.buckets.every((bucket) => bucket.axisLabel !== bucket.label)).toBe(true);
    expect(series.buckets.reduce((total, bucket) => total + bucket.totalTokens, 0)).toBe(1800);
    expect(series.buckets.reduce((total, bucket) => total + bucket.requests, 0)).toBe(3);
  });

  it("coarsens longer ranges without changing their totals", () => {
    const period = buildPeriodUsage(snapshot, "all", "2026-06-18", "2026-07-17");
    const series = buildActivitySeries(snapshot, "all", period);

    expect(series.granularity).toBe("multi-day");
    expect(series.buckets).toHaveLength(15);
    expect(series.buckets.every((bucket) => bucket.axisLabel !== bucket.label)).toBe(true);
    expect(series.buckets.reduce((total, bucket) => total + bucket.totalTokens, 0))
      .toBe(period.totals.totalTokens);
  });
});
