import fixtureSnapshot from "@usageatlas/contracts/fixtures/dashboard-v2.json";
import type { DashboardSnapshot } from "@usageatlas/contracts";
import { describe, expect, it } from "vitest";
import type { CloudStatus } from "../shared/desktop-api";
import {
  achievementNudgeCopy,
  buildAchievements,
  measureAchievements,
  nextAchievementNudge,
  nextTierShare,
  nextTierText,
  parseSeenAchievements,
  seenAchievements,
  type AchievementDay,
  type AchievementProgress
} from "./achievements";
import { shiftDay } from "./personal-analytics";

const fixture = fixtureSnapshot as unknown as DashboardSnapshot;
const today = "2026-07-17";

const run = (start: string, length: number, tokens: number): AchievementDay[] =>
  Array.from({ length }, (_, index) => ({ date: shiftDay(start, index), tokens, active: tokens > 0 }));

/** History for `providerId` covering `start`..`today`, with the given tokens per day. */
function history(snapshot: DashboardSnapshot, providerId: string, start: string, tokens: Record<string, number>): DashboardSnapshot {
  const provider = snapshot.providers.find((item) => item.id === providerId)!;
  const codex = fixture.providers.find((item) => item.id === "codex")!;
  provider.analytics = {
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

const progress = (levels: Partial<Record<AchievementProgress["id"], [number, string]>>): AchievementProgress[] =>
  (["tokens", "streak", "active-days", "big-day", "tools"] as const).map((id) => {
    const [level, earnedOn] = levels[id] ?? [0, ""];
    return { id, level, earnedOn, value: 0 };
  });

function cloud(state: CloudStatus["profile"]["state"], automatic = true): CloudStatus {
  return {
    account: state === "signed-out" ? null : { id: "user_1", email: "ada@example.com" },
    accountId: state === "signed-out" ? null : "user_1",
    automatic,
    busy: false,
    heldBack: [],
    heldBackCount: 0,
    conflicts: [],
    error: null,
    lastCompleted: null,
    loginCode: null,
    pending: 0,
    profile: state === "public" || state === "private" ? { state, handle: "ada_l" } : { state } as CloudStatus["profile"],
    progress: null
  };
}

describe("achievements", () => {
  it("dates each tier like the website does", () => {
    const days = [...run("2026-01-01", 8, 2e6), { date: "2026-01-09", tokens: 150e6, active: true }];

    expect(measureAchievements(days, ["2026-01-05", "2026-01-01"])).toEqual([
      { id: "tokens", level: 3, earnedOn: "2026-01-09", value: 166e6 },
      { id: "streak", level: 1, earnedOn: "2026-01-07", value: 9 },
      { id: "active-days", level: 0, earnedOn: "", value: 9 },
      { id: "big-day", level: 2, earnedOn: "2026-01-09", value: 150e6 },
      { id: "tools", level: 1, earnedOn: "2026-01-05", value: 2 }
    ]);
  });

  it("restarts a streak after an idle or missing day", () => {
    const days = [...run("2026-03-10", 6, 10), { date: "2026-03-16", tokens: 0, active: false },
      ...run("2026-03-17", 6, 10), ...run("2026-03-24", 3, 10)].reverse();

    expect(measureAchievements(days, []).find((item) => item.id === "streak")).toEqual({ id: "streak", level: 0, earnedOn: "", value: 6 });
  });

  it("reads every covered day on this computer, up to today", () => {
    const tokens = Object.fromEntries(run("2026-06-18", 30, 500_000).map((day) => [day.date, day.tokens!]));
    const snapshot = history(structuredClone(fixture), "codex", "2026-01-01", { ...tokens, "2026-07-18": 5e9 });
    history(snapshot, "claude", "2026-07-10", { "2026-07-09": 4e6, "2026-07-12": 10 });

    expect(buildAchievements(snapshot, today)).toEqual([
      { id: "tokens", level: 2, earnedOn: "2026-07-07", value: 15_000_010 },
      { id: "streak", level: 2, earnedOn: "2026-07-17", value: 30 },
      { id: "active-days", level: 1, earnedOn: "2026-07-17", value: 30 },
      { id: "big-day", level: 0, earnedOn: "", value: 500_010 },
      { id: "tools", level: 1, earnedOn: "2026-07-12", value: 2 }
    ]);
  });

  it("leaves out a turned-off tool", () => {
    const snapshot = history(structuredClone(fixture), "claude", "2026-07-10", { "2026-07-12": 10 });
    snapshot.providers.find((item) => item.id === "claude")!.enabled = false;

    expect(buildAchievements(snapshot, today).find((item) => item.id === "tools")).toEqual({ id: "tools", level: 0, earnedOn: "", value: 1 });
  });

  it("describes the way to the next tier", () => {
    const at = (id: AchievementProgress["id"], level: number, value: number) => ({ id, level, earnedOn: "2026-07-01", value });

    expect(nextTierText(at("tokens", 1, 6_200_000))).toBe("6,200,000 of 10,000,000 tokens");
    expect(nextTierShare(at("tokens", 1, 6_200_000))).toBeCloseTo(0.62);
    expect(nextTierText(at("big-day", 0, 0))).toBe("0 of 10,000,000 tokens");
    expect(nextTierText(at("streak", 1, 12))).toBe("12 of 30 days");
    expect(nextTierText(at("active-days", 2, 250))).toBe("250 of 365 days");
    expect(nextTierText(at("tools", 0, 1))).toBe("1 of 2 tools");
    expect(nextTierText(at("tools", 3, 6))).toBeNull();
    expect(nextTierShare(at("tools", 3, 6))).toBe(1);
  });
});

describe("achievement nudges", () => {
  it("reads only valid tiers back", () => {
    expect(parseSeenAchievements(null)).toBeNull();
    expect(parseSeenAchievements("{")).toBeNull();
    expect(parseSeenAchievements("[1]")).toBeNull();
    expect(parseSeenAchievements("{}")).toEqual({});
    expect(parseSeenAchievements(JSON.stringify({ tokens: 2, streak: 99, tools: -1, "big-day": 1.5, other: 3 })))
      .toEqual({ tokens: 2, streak: 4 });
  });

  it("never forgets a tier already announced", () => {
    expect(seenAchievements(progress({ tokens: [1, "2026-07-01"], streak: [2, "2026-07-02"] }), { tokens: 3 }))
      .toEqual({ tokens: 3, streak: 2 });
    expect(seenAchievements(progress({}), null)).toEqual({});
  });

  it("sums up on the first check, then announces the newest tier", () => {
    const earned = progress({ tokens: [2, "2026-07-10"], streak: [1, "2026-07-12"], tools: [1, "2026-06-01"] });

    expect(nextAchievementNudge(null, progress({}))).toBeNull();
    expect(nextAchievementNudge(null, earned)).toEqual({ kind: "intro", id: "streak", count: 3 });
    expect(nextAchievementNudge({ tokens: 2, streak: 1, tools: 1 }, earned)).toBeNull();
    expect(nextAchievementNudge({ tokens: 1, streak: 1, tools: 1 }, earned)).toEqual({ kind: "unlock", id: "tokens", level: 2 });
    expect(nextAchievementNudge({ tokens: 1, tools: 1 }, earned)).toEqual({ kind: "unlock", id: "streak", level: 1 });
  });

  it("points to the profile in words that fit its state", () => {
    const unlock = { kind: "unlock", id: "tokens", level: 4 } as const;

    expect(achievementNudgeCopy(unlock, cloud("signed-out"))).toEqual({ title: "Achievement unlocked: 1B tokens", description: "Show it on a public profile." });
    expect(achievementNudgeCopy(unlock, cloud("private")).description).toBe("Show it on a public profile.");
    expect(achievementNudgeCopy(unlock, cloud("public")).description).toBe("It's on your public profile too.");
    expect(achievementNudgeCopy(unlock, cloud("public", false)).description).toBe("Turn on cloud save to show them on your profile.");
    expect(achievementNudgeCopy({ kind: "intro", id: "streak", count: 3 }, cloud("missing")))
      .toEqual({ title: "You've earned 3 achievements", description: "A public profile shows them off." });
    expect(achievementNudgeCopy({ kind: "intro", id: "streak", count: 3 }, cloud("public")).description).toBe("They're on your public profile too.");
    expect(achievementNudgeCopy({ kind: "intro", id: "streak", count: 1 }, cloud("public")))
      .toEqual({ title: "You've earned an achievement", description: "It's on your public profile too." });
  });
});
