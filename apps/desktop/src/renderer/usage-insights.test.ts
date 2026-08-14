import fixtureSnapshot from "@usageatlas/contracts/fixtures/dashboard-v2.json";
import type { DashboardSnapshot } from "@usageatlas/contracts";
import { describe, expect, it } from "vitest";
import { buildModelMix, buildUsageInsights } from "./usage-insights";

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

  it("builds the whole-history model mix on its own", () => {
    const insights = buildUsageInsights(snapshot, "all");

    expect(buildModelMix(snapshot, "all")).toEqual({
      models: insights.models,
      modelProviders: insights.modelProviders,
      topModel: insights.topModel,
      totalModelTokens: insights.totalModelTokens
    });
  });

  it("scopes the model mix to the requested days", () => {
    const firstDay = buildModelMix(snapshot, "all", { endDay: "2026-07-16", startDay: "2026-07-16" });
    const bothDays = buildModelMix(snapshot, "all", { endDay: "2026-07-17", startDay: "2026-07-16" });
    const before = buildModelMix(snapshot, "all", { endDay: "2026-07-15", startDay: "2026-07-15" });

    expect(firstDay.totalModelTokens).toBe(1080);
    expect(firstDay.topModel).toMatchObject({ label: "gpt-5.6-sol", share: 100, totalTokens: 1080 });
    // The days together are the whole coverage, so they match the undated totals.
    expect(bothDays.totalModelTokens).toBe(buildModelMix(snapshot, "all").totalModelTokens);
    expect(before.models).toEqual([]);
    expect(before.topModel).toBeNull();
  });

  it("splits every model by provider so the radar can plot one series per tool", () => {
    const multiProviderSnapshot = structuredClone(snapshot);
    const second = structuredClone(multiProviderSnapshot.providers[0]);
    const analytics = second?.analytics;
    if (!second || !analytics) throw new Error("Fixture must include a provider with analytics");
    second.id = "codex-secondary";
    second.name = "Codex secondary";
    analytics.models = analytics.models.map((model) => ({ ...model, totalTokens: 600 }));
    multiProviderSnapshot.providers.push(second);

    const insights = buildUsageInsights(multiProviderSnapshot, "all");

    expect(insights.modelProviders).toEqual([
      { name: "Codex", totalTokens: 1800 },
      { name: "Codex secondary", totalTokens: 600 }
    ]);
    // Each share is measured against that provider's own volume, so a quiet tool
    // still reads as a full spoke on the radar.
    expect(insights.topModel?.providers).toEqual([
      { name: "Codex", totalTokens: 1800, share: 100 },
      { name: "Codex secondary", totalTokens: 600, share: 100 }
    ]);
  });
});
