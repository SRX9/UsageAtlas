import type { DashboardSnapshot } from "@usageatlas/contracts";
import type { CloudProfileStatus, LeaderboardGlance } from "../shared/desktop-api";
import type { PromptTriggerKind } from "../shared/growth-events";
import { fromApp } from "../shared/website-links";
import { formatCompactNumber } from "./number-format";
import { buildPeriodUsage, inclusiveDayCount, periodBounds, shiftDay, type UsageDay } from "./personal-analytics";
import { buildModelMix } from "./usage-insights";

export const PROFILE_SITE = "https://usageatlas.com";
export const LEADERBOARD_URL = fromApp(`${PROFILE_SITE}/leaderboard`, "profile");
/** The website ranks the last 30 days, today included, by default. */
const LEADERBOARD_DAYS = 30;
/** The website's handle rules (`cloud/apps/web/lib/public-profile.ts`). */
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_]{2,29}$/u;
const RESERVED_HANDLES = new Set(["admin", "support", "usageatlas", "account", "api", "www"]);
const PREVIEW_WEEKS = 20;
const TOKEN_MILESTONES = [10e6, 100e6, 1e9, 10e9, 100e9, 1e12];
const STREAK_MILESTONES = [7, 30, 100, 365];

/** At most one prompt every two weeks, and never in the first days after install. */
const PROMPT_GAP_DAYS = 14;
const SETTLE_DAYS = 3;
const MIN_TRACKED_DAYS = 3;
const MAX_DISMISSALS = 3;
const DAY_MS = 86_400_000;

export interface PreviewDay {
  date: string;
  tokens: number;
  covered: boolean;
  level: 0 | 1 | 2 | 3 | 4;
}

/** What a public profile would show, built from the history on this computer. */
export interface ProfilePreviewData {
  /** Whole weeks, Sunday first, ending today. */
  days: PreviewDay[];
  totalTokens: number;
  /** Tokens in the leaderboard's default window. */
  recentTokens: number;
  dailyAverage: number | null;
  trackedDays: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  tools: { id: string; name: string; tokens: number; share: number }[];
  models: { label: string; tokens: number; share: number }[];
  /** The last seven full days, when they beat every earlier seven-day block. */
  bestWeekTokens: number | null;
  /** Tokens per calendar year, by local date like the website. */
  yearTokens: Record<string, number>;
}

export function buildProfilePreview(snapshot: DashboardSnapshot, today: string): ProfilePreviewData {
  const bounds = periodBounds(snapshot, "all", today, "all");
  const history = buildPeriodUsage(snapshot, "all", bounds.startDay, today);
  const byDay = new Map(history.days.map((day) => [day.date, day]));

  let longestStreak = 0;
  let run = 0;
  for (const day of history.days) {
    run = isActiveDay(day) ? run + 1 : 0;
    longestStreak = Math.max(longestStreak, run);
  }

  const start = shiftDay(today, -(PREVIEW_WEEKS - 1) * 7 - new Date(`${today}T12:00:00`).getDay());
  const recent = Array.from({ length: inclusiveDayCount(start, today) }, (_, index) => {
    const date = shiftDay(start, index);
    const day = byDay.get(date);
    return { date, tokens: day?.covered ? day.totalTokens : 0, covered: Boolean(day?.covered) };
  });
  const busiest = Math.max(0, ...recent.map((day) => day.tokens));

  const totalTokens = history.totals.totalTokens;
  const recentStart = shiftDay(today, 1 - LEADERBOARD_DAYS);
  const recentTokens = history.days.reduce((sum, day) => day.covered && day.date >= recentStart ? sum + day.totalTokens : sum, 0);
  const yearTokens: Record<string, number> = {};
  for (const day of history.days) {
    if (day.covered && day.totalTokens > 0) yearTokens[day.date.slice(0, 4)] = (yearTokens[day.date.slice(0, 4)] ?? 0) + day.totalTokens;
  }
  const tools = history.providerRows.filter((row) => row.totals.totalTokens > 0).slice(0, 3)
    .map((row) => ({ id: row.id, name: row.name, tokens: row.totals.totalTokens, share: row.totals.totalTokens / totalTokens }));
  const mix = buildModelMix(snapshot, "all");
  const models = mix.models.filter((model) => model.id !== "other" && model.totalTokens > 0).slice(0, 3)
    .map((model) => ({ label: model.label, tokens: model.totalTokens, share: model.totalTokens / mix.totalModelTokens }));

  return {
    days: recent.map((day) => ({ ...day, level: intensity(day.tokens, busiest) })),
    totalTokens,
    recentTokens,
    dailyAverage: history.coveredDays ? totalTokens / history.coveredDays : null,
    trackedDays: history.coveredDays,
    activeDays: history.days.filter(isActiveDay).length,
    currentStreak: currentStreak(byDay, today),
    longestStreak,
    tools,
    models,
    bestWeekTokens: bestWeek(history.days, today),
    yearTokens
  };
}

/** The same rule as the website: a covered day with any tokens or requests. */
export function isActiveDay(day: UsageDay | undefined): boolean {
  return Boolean(day?.covered && (day.totalTokens > 0 || day.requests > 0));
}

/** Active days in a row up to today, or up to yesterday while today has no usage yet. */
export function currentStreak(byDay: ReadonlyMap<string, UsageDay>, today: string): number {
  let streak = 0;
  for (let date = isActiveDay(byDay.get(today)) ? today : shiftDay(today, -1); isActiveDay(byDay.get(date)); date = shiftDay(date, -1)) streak += 1;
  return streak;
}

function intensity(tokens: number, busiest: number): PreviewDay["level"] {
  if (tokens <= 0 || busiest <= 0) return 0;
  const ratio = tokens / busiest;
  return ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1;
}

/** Needs two earlier fully covered weeks, so a first week of history is not a "record". */
function bestWeek(days: UsageDay[], today: string): number | null {
  const byDay = new Map(days.map((day) => [day.date, day]));
  const weekTotal = (end: string) => {
    let total = 0;
    for (let offset = 0; offset < 7; offset += 1) {
      const day = byDay.get(shiftDay(end, -offset));
      if (!day?.covered) return null;
      total += day.totalTokens;
    }
    return total;
  };
  const last = weekTotal(shiftDay(today, -1));
  if (!last) return null;
  const earlier: number[] = [];
  for (let end = shiftDay(today, -8); ; end = shiftDay(end, -7)) {
    const total = weekTotal(end);
    if (total === null) break;
    earlier.push(total);
  }
  return earlier.length >= 2 && earlier.every((total) => last > total) ? last : null;
}

export type LeaderboardStanding =
  | { kind: "ranked"; rank: number; of: number }
  | { kind: "outside"; top: number; threshold: number }
  | { kind: "unranked" };

/**
 * Where the last 30 days on this computer land on the public token board. A published
 * profile finds its own row; anyone else is slotted in among the rows, sharing a rank on
 * a tie the way the website does.
 */
export function leaderboardStanding(glance: LeaderboardGlance, tokens: number, ownHandle: string | null): LeaderboardStanding {
  const own = ownHandle === null ? undefined : glance.entries.find((entry) => entry.handle === ownHandle);
  if (own) return { kind: "ranked", rank: own.rank, of: glance.ranked };
  if (tokens <= 0) return { kind: "unranked" };
  const ahead = glance.entries.filter((entry) => entry.tokens > tokens).length;
  const last = glance.entries.at(-1);
  if (last && ahead === glance.entries.length && glance.ranked > glance.entries.length)
    return { kind: "outside", top: glance.entries.length, threshold: last.tokens };
  // A live profile missing from a complete board has not saved recent usage yet.
  if (ownHandle !== null) return { kind: "unranked" };
  return { kind: "ranked", rank: ahead + 1, of: glance.ranked + 1 };
}

const joinProfiles = (count: number) =>
  count === 1 ? "Join 1 person with a public profile" : `Join ${count.toLocaleString("en-US")} people with public profiles`;

/** Wording for the standing. `live` is true once the profile is public. */
export function standingCopy(standing: LeaderboardStanding, glance: LeaderboardGlance, tokens: number, live: boolean): { title: string; detail: string } | null {
  const join = !live && glance.profiles > 0 ? ` ${joinProfiles(glance.profiles)}.` : "";
  if (standing.kind === "ranked") {
    const place = `#${standing.rank}${standing.of > 1 ? ` of ${standing.of.toLocaleString("en-US")}` : ""}`;
    return { title: `${live ? "You're" : "You'd be"} ${place} on the leaderboard`, detail: `By tokens in the last 30 days.${join}` };
  }
  if (standing.kind === "outside")
    return {
      title: `The top ${standing.top} starts at ${formatCompactNumber(standing.threshold)} tokens`,
      detail: `You've used ${formatCompactNumber(tokens)} in the last 30 days.${join}`
    };
  if (live) return null;
  if (glance.profiles === 0) return { title: "Be the first on the leaderboard", detail: "Public profiles are ranked by tokens, streaks, and consistency." };
  return { title: joinProfiles(glance.profiles), detail: "Public profiles are ranked by tokens, streaks, and consistency." };
}

export function handleProblem(handle: string): string | null {
  if (!HANDLE_PATTERN.test(handle)) return "Use 3 to 30 lowercase letters, numbers, or underscores, starting with a letter or number.";
  if (RESERVED_HANDLES.has(handle)) return "That handle is reserved. Choose another.";
  return null;
}

/** A starting handle from the account email, when it already fits the rules. */
export function suggestHandle(email: string | null | undefined): string {
  const candidate = (email?.split("@")[0] ?? "").toLowerCase().replace(/[^a-z0-9_]/gu, "").slice(0, 30);
  return handleProblem(candidate) ? "" : candidate;
}

/** Up to two letters for an avatar without a picture. */
export function initials(name: string): string {
  return name.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/u).filter(Boolean).slice(0, 2)
    .map((word) => word[0]?.toUpperCase()).join("") || "U";
}

export function publicProfileUrl(handle: string): string {
  return `${PROFILE_SITE}/@${handle}`;
}

/**
 * The year whose Wrapped to point to, or null. The same rule as the website
 * (`cloud/apps/web/lib/wrapped.ts`): a year's Wrapped opens on December 1, UTC, and is
 * talked about through January.
 */
export function wrappedSeason(now: Date): number | null {
  const month = now.getUTCMonth();
  return month === 11 ? now.getUTCFullYear() : month === 0 ? now.getUTCFullYear() - 1 : null;
}

export function wrappedUrl(handle: string, year: number): string {
  return `${PROFILE_SITE}/@${handle}/wrapped/${year}`;
}

/** The Wrapped to announce to a public profile: in season, with usage that year, once a year. */
export function wrappedNudge(profile: CloudProfileStatus, preview: ProfilePreviewData, seenYear: number | null, now: Date): { handle: string; year: number } | null {
  const year = wrappedSeason(now);
  if (profile.state !== "public" || year === null || year === seenYear || !preview.yearTokens[year]) return null;
  return { handle: profile.handle, year };
}

/** Where to finish on the website. A new profile opens the form with the handle filled in. */
export function profileSetupUrl(profile: CloudProfileStatus, handle: string): string {
  if (profile.state === "private" || profile.state === "public") return `${PROFILE_SITE}/account/profile`;
  const query = new URLSearchParams();
  if (!handleProblem(handle)) query.set("handle", handle);
  query.set("publish", "1");
  return `${PROFILE_SITE}/account/profile/edit?${query}`;
}

/** Signed-out desktops count as having no profile. An unknown answer never prompts. */
export function wantsProfilePrompt(profile: CloudProfileStatus): boolean {
  return profile.state === "signed-out" || profile.state === "missing" || profile.state === "private";
}

export interface ProfilePromptState {
  firstSeenAt: string;
  lastShownAt: string | null;
  dismissals: number;
  optedOut: boolean;
  /** Milestones already used as a reason to prompt. */
  celebrated: string[];
}

export const PROMPT_STATE_KEY = "usageatlas.profilePrompt.v1";

export function parsePromptState(raw: string | null, now: Date): ProfilePromptState {
  const fresh: ProfilePromptState = { firstSeenAt: now.toISOString(), lastShownAt: null, dismissals: 0, optedOut: false, celebrated: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw ?? "null");
  } catch {
    return fresh;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fresh;
  const stored = value as Record<string, unknown>;
  const date = (text: unknown) => typeof text === "string" && Number.isFinite(Date.parse(text)) ? text : null;
  return {
    firstSeenAt: date(stored.firstSeenAt) ?? fresh.firstSeenAt,
    lastShownAt: date(stored.lastShownAt),
    dismissals: typeof stored.dismissals === "number" && Number.isSafeInteger(stored.dismissals) && stored.dismissals > 0 ? stored.dismissals : 0,
    optedOut: stored.optedOut === true,
    celebrated: Array.isArray(stored.celebrated)
      ? stored.celebrated.filter((item): item is string => typeof item === "string").slice(0, 32)
      : []
  };
}

export type PromptTrigger =
  | { kind: "milestone-tokens"; tokens: number }
  | { kind: "milestone-streak"; days: number }
  | { kind: "best-week"; tokens: number }
  | { kind: "recap" }
  | { kind: "wrapped"; year: number };

function reachedMilestones(preview: ProfilePreviewData, now: Date): string[] {
  const season = wrappedSeason(now);
  return [
    ...(season !== null && preview.yearTokens[season] ? [`wrapped:${season}`] : []),
    ...TOKEN_MILESTONES.filter((tokens) => preview.totalTokens >= tokens).map((tokens) => `tokens:${tokens}`),
    ...STREAK_MILESTONES.filter((days) => preview.currentStreak >= days).map((days) => `streak:${days}`)
  ];
}

const daysSince = (iso: string, now: Date) => (now.getTime() - Date.parse(iso)) / DAY_MS;

/**
 * The reason to show the modal now, or null. In season, Wrapped comes first, once a year.
 * Then a milestone beats a best week, which beats a recap.
 */
export function nextPrompt(
  state: ProfilePromptState,
  profile: CloudProfileStatus,
  preview: ProfilePreviewData,
  now: Date
): PromptTrigger | null {
  if (!wantsProfilePrompt(profile) || state.optedOut || state.dismissals >= MAX_DISMISSALS) return null;
  if (preview.trackedDays < MIN_TRACKED_DAYS || preview.totalTokens <= 0) return null;
  if (daysSince(state.firstSeenAt, now) < SETTLE_DAYS) return null;
  if (state.lastShownAt && daysSince(state.lastShownAt, now) < PROMPT_GAP_DAYS) return null;
  const fresh = reachedMilestones(preview, now).filter((milestone) => !state.celebrated.includes(milestone));
  const wrapped = fresh.find((item) => item.startsWith("wrapped:"));
  if (wrapped) return { kind: "wrapped", year: Number(wrapped.slice("wrapped:".length)) };
  const highest = (prefix: string) => Math.max(0, ...fresh.filter((item) => item.startsWith(prefix)).map((item) => Number(item.slice(prefix.length))));
  const tokens = highest("tokens:");
  if (tokens) return { kind: "milestone-tokens", tokens };
  const days = highest("streak:");
  if (days) return { kind: "milestone-streak", days };
  if (preview.bestWeekTokens !== null) return { kind: "best-week", tokens: preview.bestWeekTokens };
  return { kind: "recap" };
}

/** Every milestone reached so far counts as celebrated, so one prompt never repeats a smaller one. */
export function recordPromptShown(state: ProfilePromptState, preview: ProfilePreviewData, now: Date): ProfilePromptState {
  return {
    ...state,
    lastShownAt: now.toISOString(),
    celebrated: [...new Set([...state.celebrated, ...reachedMilestones(preview, now)])]
  };
}

export function recordPromptDismissed(state: ProfilePromptState, choice: "later" | "never"): ProfilePromptState {
  return { ...state, dismissals: state.dismissals + 1, optedOut: state.optedOut || choice === "never" };
}

export function promptCopy(trigger: PromptTrigger, preview: ProfilePreviewData): { kicker: string; title: string; body: string } {
  if (trigger.kind === "wrapped")
    return {
      kicker: "AI Coding Wrapped",
      title: `Your ${trigger.year} in AI coding`,
      body: `${formatCompactNumber(preview.yearTokens[trigger.year] ?? 0)} tokens in ${trigger.year}. Public profiles get a Wrapped to share: streaks, the biggest day, and top tools and models.`
    };
  if (trigger.kind === "milestone-tokens")
    return {
      kicker: "Milestone",
      title: `You've passed ${formatCompactNumber(trigger.tokens)} tokens`,
      body: "That's a lot of building. Put it on a public profile people can see."
    };
  if (trigger.kind === "milestone-streak")
    return {
      kicker: "Streak",
      title: `${trigger.days} days in a row`,
      body: "Totals are easy to claim. A streak shows you build every day."
    };
  if (trigger.kind === "best-week")
    return {
      kicker: "Personal best",
      title: `Your biggest week yet: ${formatCompactNumber(trigger.tokens)} tokens`,
      body: "Show this week, and every one after it, on a profile that updates itself."
    };
  const tools = preview.tools.map((tool) => tool.name);
  return {
    kicker: "Public profile",
    title: "Show what you build with AI",
    body: `${formatCompactNumber(preview.totalTokens)} tokens${tools.length ? ` across ${listNames(tools)}` : ""}. One link that stays up to date.`
  };
}

export function triggerKind(trigger: PromptTrigger | null): PromptTriggerKind {
  return trigger?.kind ?? "page";
}

/** "A", "A and B", "A, B and C". */
export function listNames(names: string[]): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
