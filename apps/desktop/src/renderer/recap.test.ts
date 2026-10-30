import fixtureSnapshot from "@usageatlas/contracts/fixtures/dashboard-v2.json";
import type { DashboardSnapshot } from "@usageatlas/contracts";
import { describe, expect, it } from "vitest";
import { shiftDay } from "./personal-analytics";
import {
  blueskyPostUrl,
  buildRecap,
  recapBusiestDay,
  recapChange,
  recapDateRange,
  recapFileName,
  recapLink,
  recapPostText,
  xPostUrl
} from "./recap";

const fixture = fixtureSnapshot as unknown as DashboardSnapshot;
const today = "2026-07-17";

/** Codex history covering `start`..`today`, with the given tokens per day. */
function history(start: string, tokens: Record<string, number>): DashboardSnapshot {
  const snapshot = structuredClone(fixture);
  const codex = snapshot.providers.find((provider) => provider.id === "codex")!;
  codex.analytics = {
    ...codex.analytics!,
    coverageStart: start,
    coverageEnd: today,
    dailyModels: [],
    daily: Object.entries(tokens).map(([date, totalTokens]) => ({
      date, inputTokens: totalTokens, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0,
      totalTokens, requests: totalTokens ? 1 : 0, estimatedCostUSD: null, unpricedTokens: 0
    }))
  };
  return snapshot;
}

/** `count` days ending at `end`, each with `tokens`. */
function run(end: string, count: number, tokens: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [shiftDay(end, -index), tokens]));
}

describe("recap", () => {
  it("covers the last 7 days, today included", () => {
    const recap = buildRecap(fixture, today, "week");

    expect(recap).toMatchObject({
      period: "week",
      startDay: "2026-07-11",
      endDay: today,
      totalTokens: 1_800,
      activeDays: 2,
      streak: 2,
      tools: [{ id: "codex", name: "Codex", share: 1 }]
    });
    expect(recap.days.map((day) => day.date)).toEqual(Array.from({ length: 7 }, (_, index) => shiftDay("2026-07-11", index)));
    expect(recap.busiest?.date).toBe("2026-07-16");
    expect(recap.models[0]).toMatchObject({ label: "gpt-5.6-sol" });
    expect(recap.models.reduce((sum, model) => sum + model.share, 0)).toBeLessThanOrEqual(1);
  });

  it("covers 30 days for a month", () => {
    const recap = buildRecap(history("2026-06-01", run(today, 30, 100)), today, "month");

    expect(recap.days).toHaveLength(30);
    expect(recap).toMatchObject({ startDay: "2026-06-18", totalTokens: 3_000, activeDays: 30, streak: 30 });
  });

  it("compares with the days before only when every one of them was recorded", () => {
    const tokens = { ...run(shiftDay(today, -7), 7, 200), ...run(today, 7, 300) };

    expect(buildRecap(history("2026-07-01", tokens), today, "week").change).toBe(50);
    expect(buildRecap(history("2026-07-01", { ...tokens, ...run(today, 7, 150) }), today, "week").change).toBe(-25);
    expect(buildRecap(history("2026-07-06", tokens), today, "week").change).toBeNull();
    expect(buildRecap(history("2026-07-01", run(today, 7, 300)), today, "week").change).toBeNull();
  });

  it("words the numbers for the image and the post", () => {
    const recap = buildRecap(history("2026-07-01", { ...run(shiftDay(today, -7), 7, 200), ...run(today, 5, 300), "2026-07-14": 900 }), today, "week");

    expect(recapDateRange(recap)).toMatch(/^Jul 11\s–\s17, 2026$/u);
    expect(recapChange(recap)).toBe("+50% vs the week before");
    expect(recapChange({ ...recap, period: "month", change: -12 })).toBe("−12% vs the 30 days before");
    expect(recapChange({ ...recap, change: null })).toBeNull();
    expect(recapBusiestDay(recap)).toBe("Tue, Jul 14");
    expect(recapPostText(recap)).toBe("My week in AI coding: 2,100 tokens across Codex. 5 days in a row and counting.");
    expect(recapPostText({ ...recap, streak: 2, tools: [] })).toBe("My week in AI coding: 2,100 tokens.");
    expect(recapFileName(recap)).toBe("usageatlas-week-2026-07-17.png");
  });

  it("links to the public profile, or to the website without one", () => {
    expect(recapLink("ada_l")).toEqual({ url: "https://usageatlas.com/@ada_l", label: "usageatlas.com/@ada_l" });
    expect(recapLink(null)).toEqual({ url: "https://usageatlas.com", label: "usageatlas.com" });

    const recap = buildRecap(fixture, today, "week");
    const x = new URL(xPostUrl(recap, "https://usageatlas.com/@ada_l"));
    expect(x.origin + x.pathname).toBe("https://x.com/intent/post");
    expect(x.searchParams.get("text")).toBe(recapPostText(recap));
    expect(x.searchParams.get("url")).toBe("https://usageatlas.com/@ada_l");
    const bluesky = new URL(blueskyPostUrl(recap, "https://usageatlas.com"));
    expect(bluesky.origin + bluesky.pathname).toBe("https://bsky.app/intent/compose");
    expect(bluesky.searchParams.get("text")).toBe(`${recapPostText(recap)}\nhttps://usageatlas.com`);
  });
});
