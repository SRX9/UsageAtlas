import type { DashboardSnapshot } from "@usageatlas/contracts";
import type { CloudStatus } from "../shared/desktop-api";
import { formatCompactNumber } from "./number-format";
import { buildPeriodUsage, enabledProviders, periodBounds } from "./personal-analytics";
import { isActiveDay } from "./profile-promotion";

// The website's achievement families and tiers (`cloud/apps/web/lib/achievements.ts`),
// so what unlocks here is what a public profile shows. Keep the two lists the same.

export type AchievementId = "tokens" | "streak" | "active-days" | "big-day" | "tools";

export interface AchievementFamily {
  id: AchievementId;
  name: string;
  /** Lowest first. */
  tiers: readonly number[];
  /** "1B tokens", "30-day streak". */
  label(tier: number): string;
  describe(tier: number): string;
}

/** Thresholds are round numbers, so "1M" and "100B" are exact. */
const short = (value: number) => value >= 1e9 ? `${value / 1e9}B` : value >= 1e6 ? `${value / 1e6}M` : String(value);

export const ACHIEVEMENTS: readonly AchievementFamily[] = [
  { id: "tokens", name: "Tokens", tiers: [1e6, 1e7, 1e8, 1e9, 1e10, 1e11],
    label: (tier) => `${short(tier)} tokens`, describe: (tier) => `Processed ${short(tier)} tokens in total.` },
  { id: "streak", name: "Streak", tiers: [7, 30, 100, 365],
    label: (tier) => `${tier}-day streak`, describe: (tier) => `Used AI coding tools ${tier} days in a row.` },
  { id: "active-days", name: "Active days", tiers: [30, 100, 365],
    label: (tier) => `${tier} active days`, describe: (tier) => `Used AI coding tools on ${tier} different days.` },
  { id: "big-day", name: "Biggest day", tiers: [1e7, 1e8, 1e9],
    label: (tier) => `${short(tier)}-token day`, describe: (tier) => `Processed ${short(tier)} tokens in a single day.` },
  { id: "tools", name: "Tools", tiers: [2, 3, 5],
    label: (tier) => `${tier} tools`, describe: (tier) => `Used ${tier} different AI coding tools.` }
];

export function achievementFamily(id: AchievementId): AchievementFamily {
  return ACHIEVEMENTS.find((family) => family.id === id)!;
}

export interface AchievementProgress {
  id: AchievementId;
  /** 0 until the first tier. */
  level: number;
  /** The local day the current tier was reached, or "" at level 0. */
  earnedOn: string;
  /** Lifetime total, best run, or best day, depending on the family. */
  value: number;
}

export interface AchievementDay { date: string; tokens: number | null; active: boolean }

const nextDay = (date: string) => {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
};

/** Every family's progress from saved days (any order, gaps allowed) and the first day each tool had tokens. */
export function measureAchievements(days: readonly AchievementDay[], toolStarts: readonly string[]): AchievementProgress[] {
  const reached = new Map<AchievementId, string[]>(ACHIEVEMENTS.map((family) => [family.id, []]));
  const best = new Map<AchievementId, number>();
  const record = (id: AchievementId, value: number, date: string) => {
    const tiers = achievementFamily(id).tiers;
    const dates = reached.get(id)!;
    while (dates.length < tiers.length && value >= tiers[dates.length]) dates.push(date);
    best.set(id, Math.max(best.get(id) ?? 0, value));
  };
  let total = 0;
  let run = 0;
  let active = 0;
  let previous: string | null = null;
  for (const day of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    const tokens = day.tokens ?? 0;
    total += tokens;
    if (previous === null || day.date !== nextDay(previous)) run = 0;
    run = day.active ? run + 1 : 0;
    if (day.active) active += 1;
    previous = day.date;
    record("tokens", total, day.date);
    record("big-day", tokens, day.date);
    record("streak", run, day.date);
    record("active-days", active, day.date);
  }
  [...toolStarts].sort().forEach((date, index) => record("tools", index + 1, date));
  return ACHIEVEMENTS.map(({ id }) => {
    const dates = reached.get(id)!;
    return { id, level: dates.length, earnedOn: dates.at(-1) ?? "", value: best.get(id) ?? 0 };
  });
}

/** Progress from the history on this computer. A synced profile can be ahead of it. */
export function buildAchievements(snapshot: DashboardSnapshot, today: string): AchievementProgress[] {
  const bounds = periodBounds(snapshot, "all", today, "all");
  const history = buildPeriodUsage(snapshot, "all", bounds.startDay, today);
  const days = history.days.filter((day) => day.covered)
    .map((day) => ({ date: day.date, tokens: day.totalTokens, active: isActiveDay(day) }));
  const toolStarts = enabledProviders(snapshot).flatMap((provider) => {
    const analytics = provider.analytics;
    if (analytics?.status !== "available" && analytics?.status !== "partial") return [];
    const first = analytics.daily
      .filter((day) => day.totalTokens > 0 && day.date >= analytics.coverageStart && day.date <= analytics.coverageEnd && day.date <= today)
      .reduce<string | null>((earliest, day) => earliest === null || day.date < earliest ? day.date : earliest, null);
    return first ? [first] : [];
  });
  return measureAchievements(days, toolStarts);
}

/** "6.2M of 10M tokens" toward the next tier, or null at the top tier. */
export function nextTierText(progress: AchievementProgress): string | null {
  const next = achievementFamily(progress.id).tiers[progress.level];
  if (next === undefined) return null;
  if (progress.id === "tokens" || progress.id === "big-day")
    return `${formatCompactNumber(progress.value)} of ${formatCompactNumber(next)} tokens`;
  const unit = progress.id === "tools" ? "tools" : "days";
  return `${progress.value.toLocaleString("en-US")} of ${next} ${unit}`;
}

export function nextTierShare(progress: AchievementProgress): number {
  const next = achievementFamily(progress.id).tiers[progress.level];
  return next === undefined ? 1 : Math.min(1, progress.value / next);
}

/** The highest tier already announced, per family. */
export type SeenAchievements = Partial<Record<AchievementId, number>>;

export const ACHIEVEMENTS_SEEN_KEY = "usageatlas.achievements.v1";

/** Null before the first check, which then sums up instead of announcing each tier. */
export function parseSeenAchievements(raw: string | null): SeenAchievements | null {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? "null");
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const seen: SeenAchievements = {};
  for (const { id, tiers } of ACHIEVEMENTS) {
    const level = (value as Record<string, unknown>)[id];
    if (typeof level === "number" && Number.isSafeInteger(level) && level > 0) seen[id] = Math.min(level, tiers.length);
  }
  return seen;
}

/** Never lowers a tier, so turning a tool off and on again doesn't announce it twice. */
export function seenAchievements(progress: readonly AchievementProgress[], previous: SeenAchievements | null): SeenAchievements {
  const seen: SeenAchievements = { ...previous };
  for (const { id, level } of progress) if (level > (seen[id] ?? 0)) seen[id] = level;
  return seen;
}

/** `id` is the newest tier's family. */
export type AchievementNudge =
  | { kind: "intro"; id: AchievementId; count: number }
  | { kind: "unlock"; id: AchievementId; level: number };

const newest = (items: AchievementProgress[]) => items.reduce((latest, item) => item.earnedOn > latest.earnedOn ? item : latest);

/** The first check names how many are earned; later ones announce the newest tier. */
export function nextAchievementNudge(seen: SeenAchievements | null, progress: readonly AchievementProgress[]): AchievementNudge | null {
  const earned = progress.filter((item) => item.level > 0);
  if (!earned.length) return null;
  if (seen === null) return { kind: "intro", id: newest(earned).id, count: earned.length };
  const fresh = earned.filter((item) => item.level > (seen[item.id] ?? 0));
  if (!fresh.length) return null;
  const { id, level } = newest(fresh);
  return { kind: "unlock", id, level };
}

/** A live profile only has them while cloud save runs; without a profile, they're a reason to get one. */
export function achievementNudgeCopy(nudge: AchievementNudge, status: Pick<CloudStatus, "automatic" | "profile">): { title: string; description: string } {
  const one = nudge.kind === "unlock" || nudge.count === 1;
  const description = status.profile.state !== "public"
    ? one ? "Show it on a public profile." : "A public profile shows them off."
    : status.automatic
      ? one ? "It's on your public profile too." : "They're on your public profile too."
      : "Turn on cloud save to show them on your profile.";
  if (nudge.kind === "intro")
    return { title: one ? "You've earned an achievement" : `You've earned ${nudge.count} achievements`, description };
  const family = achievementFamily(nudge.id);
  return { title: `Achievement unlocked: ${family.label(family.tiers[nudge.level - 1])}`, description };
}
