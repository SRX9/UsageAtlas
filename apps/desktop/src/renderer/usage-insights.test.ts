import fixtureSnapshot from "@usageatlas/contracts/fixtures/dashboard-v2.json";
import type { DashboardSnapshot } from "@usageatlas/contracts";
import { describe, expect, it } from "vitest";
import { buildUsageInsights } from "./usage-insights";

const snapshot = fixtureSnapshot as unknown as DashboardSnapshot;

describe("usage insights", () => {
  it("derives a workstyle, model share, and typical week from collected history", () => {
    const insights = buildUsageInsights(snapshot, "all");

    expect(insights.persona).toMatchObject({ kind: "morning", label: "Morning starter", share: 72 });
    expect(insights.peakHour).toBe(11);
    expect(insights.activeHours).toBe(3);
    expect(insights.topModel).toMatchObject({ label: "gpt-5.6-sol", share: 100, totalTokens: 1800 });
    expect(insights.busiestWeekday).toMatchObject({ label: "Thursday", share: 60, totalTokens: 1080 });
    expect(insights.weekdays[3]?.hourBlocks[4]).toMatchObject({ hour: 8, totalTokens: 580, intensity: 4 });
  });

  it("keeps providers without analytics out of the evidence", () => {
    const insights = buildUsageInsights(snapshot, "claude");

    expect(insights).toMatchObject({
      activeHours: 0,
      coverageDays: 0,
      hourlyHistoryAvailable: false,
      persona: null,
      topModel: null
    });
    expect(insights.models).toEqual([]);
    expect(insights.weekdays.every((day) => day.totalTokens === 0)).toBe(true);
  });

  it("classifies late-night usage without relying on the snapshot totals", () => {
    const nightSnapshot = structuredClone(snapshot);
    const analytics = nightSnapshot.providers[0]?.analytics;
    const source = analytics?.hourly?.[0];
    if (!analytics || !source) throw new Error("Fixture must include hourly analytics");
    analytics.hourly = [{ ...source, date: "2026-07-17", hour: 23, totalTokens: 1000 }];

    const insights = buildUsageInsights(nightSnapshot, "codex");

    expect(insights.persona).toMatchObject({ kind: "night", label: "Night owl", share: 100 });
    expect(insights.peakHour).toBe(23);
  });

  it("combines the same model label across providers", () => {
    const multiProviderSnapshot = structuredClone(snapshot);
    const second = structuredClone(multiProviderSnapshot.providers[0]);
    if (!second) throw new Error("Fixture must include a provider");
    second.id = "codex-secondary";
    second.name = "Codex secondary";
    multiProviderSnapshot.providers.push(second);

    const insights = buildUsageInsights(multiProviderSnapshot, "all");

    expect(insights.topModel).toMatchObject({ label: "gpt-5.6-sol", totalTokens: 3600, share: 100 });
    expect(insights.topModel?.providerNames).toEqual(["Codex", "Codex secondary"]);
  });
});
