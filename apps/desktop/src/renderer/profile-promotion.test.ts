import fixtureSnapshot from "@usageatlas/contracts/fixtures/dashboard-v2.json";
import type { DashboardSnapshot } from "@usageatlas/contracts";
import { describe, expect, it } from "vitest";
import type { LeaderboardGlance } from "../shared/desktop-api";
import {
  buildProfilePreview,
  handleProblem,
  leaderboardStanding,
  nextPrompt,
  parsePromptState,
  profileSetupUrl,
  promptCopy,
  recordPromptDismissed,
  recordPromptShown,
  standingCopy,
  suggestHandle,
  wrappedNudge,
  wrappedSeason,
  wrappedUrl,
  type ProfilePreviewData,
  type ProfilePromptState
} from "./profile-promotion";
import { shiftDay } from "./personal-analytics";

const fixture = fixtureSnapshot as unknown as DashboardSnapshot;

/** Codex history covering `start`..`end`, with the given tokens per day and zero elsewhere. */
function history(start: string, end: string, tokens: Record<string, number>): DashboardSnapshot {
  const snapshot = structuredClone(fixture);
  const codex = snapshot.providers.find((provider) => provider.id === "codex")!;
  codex.analytics = {
    ...codex.analytics!,
    coverageStart: start,
    coverageEnd: end,
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

describe("profile preview", () => {
  it("summarises local history the way the public profile does", () => {
    const preview = buildProfilePreview(fixture, "2026-07-17");
    expect(preview).toMatchObject({
      totalTokens: 1_800,
      trackedDays: 90,
      activeDays: 2,
      currentStreak: 2,
      longestStreak: 2,
      tools: [{ id: "codex", name: "Codex", tokens: 1_800, share: 1 }]
    });
    expect(preview.dailyAverage).toBe(20);
    expect(preview.models[0]).toMatchObject({ label: "gpt-5.6-sol" });
    expect(preview.yearTokens).toEqual({ 2026: 1_800 });
  });

  it("totals each calendar year by local date for Wrapped", () => {
    const snapshot = history("2025-12-30", "2026-01-02", { "2025-12-30": 100, "2025-12-31": 250, "2026-01-01": 0, "2026-01-02": 40 });
    expect(buildProfilePreview(snapshot, "2026-01-02").yearTokens).toEqual({ 2025: 350, 2026: 40 });
  });

  it("lays the calendar out in whole weeks that start on Sunday and end today", () => {
    const preview = buildProfilePreview(fixture, "2026-07-17");
    expect(new Date(`${preview.days[0].date}T12:00:00`).getDay()).toBe(0);
    expect(preview.days.at(-1)?.date).toBe("2026-07-17");
    expect(preview.days).toHaveLength(19 * 7 + 6);
    expect(preview.days.slice(-2).map((day) => day.level)).toEqual([4, 3]);
    expect(preview.days.find((day) => day.date === "2026-04-18")).toMatchObject({ covered: false, level: 0 });
  });

  it("keeps a streak alive until today ends", () => {
    const today = "2026-07-17";
    const snapshot = history("2026-07-01", today, run("2026-07-16", 5, 100));
    expect(buildProfilePreview(snapshot, today)).toMatchObject({ currentStreak: 5, longestStreak: 5 });
    expect(buildProfilePreview(snapshot, "2026-07-18")).toMatchObject({ currentStreak: 0 });
  });

  it("calls the last seven days a best week only against two earlier full weeks", () => {
    const today = "2026-07-29";
    const quiet = { ...run(shiftDay(today, -8), 21, 100), ...run(shiftDay(today, -1), 7, 200) };
    expect(buildProfilePreview(history("2026-07-07", today, quiet), today).bestWeekTokens).toBe(1_400);
    expect(buildProfilePreview(history("2026-07-14", today, quiet), today).bestWeekTokens).toBeNull();
    const tied = { ...quiet, [shiftDay(today, -10)]: 800 };
    expect(buildProfilePreview(history("2026-07-07", today, tied), today).bestWeekTokens).toBeNull();
    expect(buildProfilePreview(history("2026-07-07", shiftDay(today, -2), quiet), today).bestWeekTokens).toBeNull();
  });
});

describe("profile prompt timing", () => {
  const now = new Date("2026-07-29T12:00:00Z");
  const settled: ProfilePromptState = {
    firstSeenAt: "2026-07-01T00:00:00.000Z", lastShownAt: null, dismissals: 0, optedOut: false, celebrated: []
  };
  const preview = (overrides: Partial<ProfilePreviewData> = {}): ProfilePreviewData => ({
    days: [], totalTokens: 5_000, recentTokens: 5_000, dailyAverage: 1_000, trackedDays: 10, activeDays: 5,
    currentStreak: 2, longestStreak: 3, tools: [], models: [], bestWeekTokens: null, yearTokens: { 2026: 5_000 }, ...overrides
  });

  it("prompts only signed-out users and accounts without a public profile", () => {
    expect(nextPrompt(settled, { state: "signed-out" }, preview(), now)).toEqual({ kind: "recap" });
    expect(nextPrompt(settled, { state: "missing" }, preview(), now)).toEqual({ kind: "recap" });
    expect(nextPrompt(settled, { state: "private", handle: "ada" }, preview(), now)).toEqual({ kind: "recap" });
    expect(nextPrompt(settled, { state: "public", handle: "ada" }, preview(), now)).toBeNull();
    expect(nextPrompt(settled, { state: "unknown" }, preview(), now)).toBeNull();
  });

  it("waits for real usage and a few days after install", () => {
    const missing = { state: "missing" } as const;
    expect(nextPrompt(settled, missing, preview({ trackedDays: 2 }), now)).toBeNull();
    expect(nextPrompt(settled, missing, preview({ totalTokens: 0 }), now)).toBeNull();
    expect(nextPrompt({ ...settled, firstSeenAt: "2026-07-27T12:00:00.000Z" }, missing, preview(), now)).toBeNull();
  });

  it("leaves two weeks between prompts and stops after three dismissals or a no", () => {
    const missing = { state: "missing" } as const;
    expect(nextPrompt({ ...settled, lastShownAt: "2026-07-16T12:00:00.000Z" }, missing, preview(), now)).toBeNull();
    expect(nextPrompt({ ...settled, lastShownAt: "2026-07-15T12:00:00.000Z" }, missing, preview(), now)).toEqual({ kind: "recap" });
    let state = settled;
    for (let count = 0; count < 2; count += 1) state = recordPromptDismissed(state, "later");
    expect(nextPrompt(state, missing, preview(), now)).toEqual({ kind: "recap" });
    expect(nextPrompt(recordPromptDismissed(state, "later"), missing, preview(), now)).toBeNull();
    expect(nextPrompt(recordPromptDismissed(settled, "never"), missing, preview(), now)).toBeNull();
  });

  it("leads with the largest new milestone, then a streak, then a best week", () => {
    const missing = { state: "missing" } as const;
    const busy = preview({ totalTokens: 2.5e9, currentStreak: 31, bestWeekTokens: 9e8 });
    expect(nextPrompt(settled, missing, busy, now)).toEqual({ kind: "milestone-tokens", tokens: 1e9 });

    const shown = recordPromptShown(settled, busy, now);
    expect(shown.celebrated).toEqual(["tokens:10000000", "tokens:100000000", "tokens:1000000000", "streak:7", "streak:30"]);
    const later = new Date(now.getTime() + 15 * 86_400_000);
    expect(nextPrompt(shown, missing, busy, later)).toEqual({ kind: "best-week", tokens: 9e8 });
    expect(nextPrompt(shown, missing, { ...busy, bestWeekTokens: null }, later)).toEqual({ kind: "recap" });
    expect(nextPrompt(shown, missing, { ...busy, currentStreak: 100 }, later)).toEqual({ kind: "milestone-streak", days: 100 });
  });

  it("puts Wrapped first in December and January, once a year, for a year with usage", () => {
    const missing = { state: "missing" } as const;
    const december = new Date("2026-12-11T12:00:00Z");
    const busy = preview({ totalTokens: 2.5e9, currentStreak: 31, yearTokens: { 2025: 1e9, 2026: 1.5e9 } });
    expect(nextPrompt(settled, missing, busy, december)).toEqual({ kind: "wrapped", year: 2026 });
    expect(nextPrompt(settled, { state: "private", handle: "ada" }, busy, december)).toEqual({ kind: "wrapped", year: 2026 });
    expect(nextPrompt(settled, { state: "public", handle: "ada" }, busy, december)).toBeNull();

    const shown = recordPromptShown(settled, busy, december);
    expect(shown.celebrated[0]).toBe("wrapped:2026");
    const january = new Date("2027-01-10T12:00:00Z");
    expect(nextPrompt(shown, missing, busy, january)).toEqual({ kind: "recap" });
    expect(nextPrompt(shown, missing, { ...busy, yearTokens: { 2027: 1 } }, new Date("2027-12-01T00:00:00Z"))).toEqual({ kind: "wrapped", year: 2027 });

    expect(nextPrompt(settled, missing, preview({ yearTokens: { 2025: 9 } }), december)).toEqual({ kind: "recap" });
    expect(nextPrompt(settled, missing, preview({ yearTokens: { 2026: 9 } }), january)).toEqual({ kind: "wrapped", year: 2026 });
    expect(nextPrompt(settled, missing, preview(), new Date("2026-11-30T23:59:59Z"))).toEqual({ kind: "recap" });
    expect(nextPrompt({ ...settled, lastShownAt: "2026-12-01T00:00:00.000Z" }, missing, busy, december)).toBeNull();
    expect(nextPrompt(recordPromptDismissed(settled, "never"), missing, busy, december)).toBeNull();
  });

  it("reads saved state defensively", () => {
    const fresh = parsePromptState("{not json", now);
    expect(fresh).toEqual({ firstSeenAt: now.toISOString(), lastShownAt: null, dismissals: 0, optedOut: false, celebrated: [] });
    expect(parsePromptState(JSON.stringify({ firstSeenAt: "nope", lastShownAt: 3, dismissals: -2, optedOut: "yes", celebrated: ["tokens:1", 4] }), now))
      .toEqual({ ...fresh, celebrated: ["tokens:1"] });
    expect(parsePromptState(JSON.stringify(settled), now)).toEqual(settled);
  });

  it("names the tools in the recap", () => {
    const tools = [
      { id: "codex", name: "Codex", tokens: 1, share: 0.5 },
      { id: "claude", name: "Claude", tokens: 1, share: 0.3 },
      { id: "cursor", name: "Cursor", tokens: 1, share: 0.2 }
    ];
    expect(promptCopy({ kind: "recap" }, preview({ totalTokens: 1_200_000, tools })).body)
      .toBe("1,200,000 tokens across Codex, Claude and Cursor. One link that stays up to date.");
    expect(promptCopy({ kind: "milestone-tokens", tokens: 1e9 }, preview()).title).toBe("You've passed 1,000,000,000 tokens");
    expect(promptCopy({ kind: "wrapped", year: 2026 }, preview({ yearTokens: { 2026: 2.14e9 } }))).toEqual({
      kicker: "AI Coding Wrapped",
      title: "Your 2026 in AI coding",
      body: "2,140,000,000 tokens in 2026. Public profiles get a Wrapped to share: streaks, the biggest day, and top tools and models."
    });
  });
});

describe("leaderboard standing", () => {
  const board = (tokens: number[], ranked = tokens.length, profiles = ranked + 2): LeaderboardGlance => {
    const entries = tokens.map((value, index) => ({ handle: `user_${index}`, rank: 0, tokens: value }));
    entries.forEach((entry, index) => { entry.rank = index && entries[index - 1].tokens === entry.tokens ? entries[index - 1].rank : index + 1; });
    return { profiles, ranked, entries, faces: [] };
  };

  it("counts the leaderboard's 30 days, today included", () => {
    const today = "2026-07-30";
    const snapshot = history("2026-06-01", today, { [shiftDay(today, -30)]: 1_000, [shiftDay(today, -29)]: 20, [today]: 3 });
    expect(buildProfilePreview(snapshot, today).recentTokens).toBe(23);
  });

  it("slots a new profile in among the rows, sharing a rank on a tie", () => {
    const glance = board([500, 300, 300, 100]);
    expect(leaderboardStanding(glance, 1_000, null)).toEqual({ kind: "ranked", rank: 1, of: 5 });
    expect(leaderboardStanding(glance, 300, null)).toEqual({ kind: "ranked", rank: 2, of: 5 });
    expect(leaderboardStanding(glance, 299, null)).toEqual({ kind: "ranked", rank: 4, of: 5 });
    expect(leaderboardStanding(glance, 50, null)).toEqual({ kind: "ranked", rank: 5, of: 5 });
    expect(leaderboardStanding(glance, 0, null)).toEqual({ kind: "unranked" });
    expect(leaderboardStanding(board([]), 10, null)).toEqual({ kind: "ranked", rank: 1, of: 1 });
  });

  it("names the cut-off below the top of a longer board", () => {
    const glance = board([900, 600, 400], 40);
    expect(leaderboardStanding(glance, 399, null)).toEqual({ kind: "outside", top: 3, threshold: 400 });
    expect(leaderboardStanding(glance, 400, null)).toEqual({ kind: "ranked", rank: 3, of: 41 });
  });

  it("reads a live profile's own row", () => {
    const glance = board([900, 600, 400], 40);
    expect(leaderboardStanding(glance, 5, "user_1")).toEqual({ kind: "ranked", rank: 2, of: 40 });
    expect(leaderboardStanding(glance, 5, "someone")).toEqual({ kind: "outside", top: 3, threshold: 400 });
    expect(leaderboardStanding(board([900]), 5_000, "someone")).toEqual({ kind: "unranked" });
  });

  it("words each standing", () => {
    const glance = board([900, 600, 400], 40, 57);
    expect(standingCopy({ kind: "ranked", rank: 2, of: 41 }, glance, 700, false)).toEqual({
      title: "You'd be #2 of 41 on the leaderboard",
      detail: "By tokens in the last 30 days. Join 57 people with public profiles."
    });
    expect(standingCopy({ kind: "ranked", rank: 2, of: 40 }, glance, 700, true)).toEqual({
      title: "You're #2 of 40 on the leaderboard", detail: "By tokens in the last 30 days."
    });
    expect(standingCopy({ kind: "ranked", rank: 1, of: 1 }, board([], 0, 0), 10, false)?.title).toBe("You'd be #1 on the leaderboard");
    expect(standingCopy({ kind: "outside", top: 100, threshold: 1_250_000 }, glance, 90_000, false)).toEqual({
      title: "The top 100 starts at 1,250,000 tokens",
      detail: "You've used 90,000 in the last 30 days. Join 57 people with public profiles."
    });
    expect(standingCopy({ kind: "unranked" }, board([], 0, 1), 0, false)?.title).toBe("Join 1 person with a public profile");
    expect(standingCopy({ kind: "unranked" }, board([], 0, 0), 0, false)?.title).toBe("Be the first on the leaderboard");
    expect(standingCopy({ kind: "unranked" }, glance, 0, true)).toBeNull();
  });
});

describe("Wrapped", () => {
  it("uses the website's season, in UTC: December for this year, January for last year", () => {
    expect(wrappedSeason(new Date("2026-11-30T23:59:59Z"))).toBeNull();
    expect(wrappedSeason(new Date("2026-12-01T00:00:00Z"))).toBe(2026);
    expect(wrappedSeason(new Date("2026-12-31T23:59:59Z"))).toBe(2026);
    expect(wrappedSeason(new Date("2027-01-31T23:59:59Z"))).toBe(2026);
    expect(wrappedSeason(new Date("2027-02-01T00:00:00Z"))).toBeNull();
    expect(wrappedUrl("ada_l", 2026)).toBe("https://usageatlas.com/@ada_l/wrapped/2026");
  });

  it("tells a public profile once a year, when it has usage that year", () => {
    const december = new Date("2026-12-11T12:00:00Z");
    const usage = buildProfilePreview(history("2026-12-01", "2026-12-11", run("2026-12-11", 5, 100)), "2026-12-11");
    const live = { state: "public", handle: "ada_l" } as const;
    expect(wrappedNudge(live, usage, null, december)).toEqual({ handle: "ada_l", year: 2026 });
    expect(wrappedNudge(live, usage, 2025, december)).toEqual({ handle: "ada_l", year: 2026 });
    expect(wrappedNudge(live, usage, 2026, december)).toBeNull();
    expect(wrappedNudge(live, usage, null, new Date("2027-01-05T12:00:00Z"))).toEqual({ handle: "ada_l", year: 2026 });
    expect(wrappedNudge(live, usage, null, new Date("2026-11-30T12:00:00Z"))).toBeNull();
    expect(wrappedNudge(live, usage, null, new Date("2027-12-05T12:00:00Z"))).toBeNull();
    expect(wrappedNudge({ state: "private", handle: "ada_l" }, usage, null, december)).toBeNull();
    expect(wrappedNudge({ state: "signed-out" }, usage, null, december)).toBeNull();
  });
});

describe("profile handles and links", () => {
  it("applies the website's handle rules", () => {
    expect(handleProblem("ada_lovelace")).toBeNull();
    expect(handleProblem("ab")).not.toBeNull();
    expect(handleProblem("_ada")).not.toBeNull();
    expect(handleProblem("Ada")).not.toBeNull();
    expect(handleProblem("admin")).toBe("That handle is reserved. Choose another.");
  });

  it("suggests a handle from the email only when it is usable", () => {
    expect(suggestHandle("Ada.Lovelace+ai@example.com")).toBe("adalovelaceai");
    expect(suggestHandle("x@example.com")).toBe("");
    expect(suggestHandle("support@example.com")).toBe("");
    expect(suggestHandle(null)).toBe("");
  });

  it("sends new profiles to the form with the handle filled in", () => {
    expect(profileSetupUrl({ state: "missing" }, "ada_l")).toBe("https://usageatlas.com/account/profile/edit?handle=ada_l&publish=1");
    expect(profileSetupUrl({ state: "signed-out" }, "no")).toBe("https://usageatlas.com/account/profile/edit?publish=1");
    expect(profileSetupUrl({ state: "private", handle: "ada" }, "")).toBe("https://usageatlas.com/account/profile");
  });
});
