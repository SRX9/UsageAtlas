import type {
  DashboardProvider,
  DashboardSnapshot,
  UsageDailyMetric,
  UsageTotals
} from "@usageatlas/contracts";
import { sumUsageTotals } from "./dashboard-model";

export type AnalyticsRange = 7 | 30 | 90 | "all";
export type ProviderScope = "all" | string;
export type CostBasis = "api_equivalent" | "opencode_reported" | "mixed";

export interface UsageDay extends UsageTotals {
  date: string;
  covered: boolean;
}

export interface ProviderPeriodUsage {
  id: string;
  name: string;
  totals: UsageTotals;
}

export interface PeriodUsage {
  startDay: string;
  endDay: string;
  days: UsageDay[];
  totals: UsageTotals;
  providerRows: ProviderPeriodUsage[];
  reportingProviders: number;
  coveredDays: number;
  coverageStart: string | null;
  coverageEnd: string | null;
  partialProviders: string[];
  costBasis: CostBasis;
}

export interface CostPresentation {
  label: string;
  detail: string;
  unavailableReason: string | null;
}

export interface AnalyticsIssue {
  message: string;
  /** Why the history is incomplete and what to do about it, straight from the scanner. */
  detail: string | null;
  tone: "warning" | "error";
}

export interface UsageBaseline {
  days: number;
  averageTokens: number;
  averageRequests: number;
  averageCostUSD: number | null;
}

export interface TokenComposition {
  freshInput: number;
  cacheRead: number;
  cacheCreated: number;
  output: number;
}

export function enabledProviders(snapshot: DashboardSnapshot): DashboardProvider[] {
  return snapshot.providers.filter((provider) => provider.enabled);
}

export function providersForScope(snapshot: DashboardSnapshot, scope: ProviderScope): DashboardProvider[] {
  const providers = enabledProviders(snapshot);
  return scope === "all" ? providers : providers.filter((provider) => provider.id === scope);
}

export function todayDay(now = new Date()): string {
  return calendarDay(now);
}

export function shiftDay(day: string, offset: number): string {
  const date = parseDay(day);
  date.setDate(date.getDate() + offset);
  return calendarDay(date);
}

export function inclusiveDayCount(startDay: string, endDay: string): number {
  const start = parseDay(startDay).valueOf();
  const end = parseDay(endDay).valueOf();
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}

export function periodBounds(
  snapshot: DashboardSnapshot,
  scope: ProviderScope,
  endDay: string,
  range: AnalyticsRange
): { startDay: string; endDay: string } {
  if (range !== "all") return { startDay: shiftDay(endDay, -(range - 1)), endDay };
  const analytics = providersForScope(snapshot, scope)
    .flatMap((provider) => provider.analytics?.status === "available" || provider.analytics?.status === "partial"
      ? [provider.analytics]
      : []);
  const startDay = analytics.reduce<string | null>(
    (earliest, item) => earliest === null || item.coverageStart < earliest ? item.coverageStart : earliest,
    null
  );
  return { startDay: startDay ?? endDay, endDay };
}

export function buildPeriodUsage(
  snapshot: DashboardSnapshot,
  scope: ProviderScope,
  startDay: string,
  endDay: string
): PeriodUsage {
  const reporting = providersForScope(snapshot, scope)
    .filter((provider) => provider.analytics?.status === "available" || provider.analytics?.status === "partial");
  const partialProviders = reporting
    .filter((provider) => provider.analytics?.status === "partial")
    .map((provider) => provider.name);
  const providerMaps = reporting.map((provider) => ({
    provider,
    byDay: new Map(provider.analytics?.daily.map((day) => [day.date, day]) ?? [])
  }));
  const dates = dayRange(startDay, endDay);
  const days = dates.map<UsageDay>((date) => {
    const entries = providerMaps.flatMap(({ provider, byDay }) => {
      const analytics = provider.analytics;
      if (!analytics || date < analytics.coverageStart || date > analytics.coverageEnd) return [];
      return [byDay.get(date) ?? emptyUsage()];
    });
    const totals = sumUsageTotals(entries);
    return {
      date,
      covered: entries.length > 0,
      ...totals
    };
  });
  const providerRows = providerMaps.map<ProviderPeriodUsage>(({ provider, byDay }) => {
    const entries = dates.flatMap((date) => {
      const analytics = provider.analytics;
      if (!analytics || date < analytics.coverageStart || date > analytics.coverageEnd) return [];
      return [byDay.get(date) ?? emptyUsage()];
    });
    const totals = sumUsageTotals(entries);
    return {
      id: provider.id,
      name: provider.name,
      totals: {
        ...totals,
        estimatedCostUSD: provider.analytics?.status === "partial" ? null : totals.estimatedCostUSD
      }
    };
  }).sort((left, right) => right.totals.totalTokens - left.totals.totalTokens);
  const coverageStart = reporting.reduce<string | null>((earliest, provider) => {
    const start = provider.analytics?.coverageStart;
    return start && (earliest === null || start < earliest) ? start : earliest;
  }, null);
  const coverageEnd = reporting.reduce<string | null>((latest, provider) => {
    const end = provider.analytics?.coverageEnd;
    return end && (latest === null || end > latest) ? end : latest;
  }, null);

  return {
    startDay,
    endDay,
    days,
    totals: sumUsageTotals(days),
    providerRows,
    reportingProviders: reporting.length,
    coveredDays: days.filter((day) => day.covered).length,
    coverageStart,
    coverageEnd,
    partialProviders,
    costBasis: costBasis(reporting.map((provider) => provider.id))
  };
}

export function buildBaseline(
  snapshot: DashboardSnapshot,
  scope: ProviderScope,
  selectedDay: string,
  days = 28
): UsageBaseline {
  const period = buildPeriodUsage(
    snapshot,
    scope,
    shiftDay(selectedDay, -days),
    shiftDay(selectedDay, -1)
  );
  const covered = period.days.filter((day) => day.covered);
  const divisor = Math.max(1, covered.length);
  const priced = covered
    .map((day) => day.estimatedCostUSD)
    .filter((value): value is number => value !== null);
  const costComplete = covered.every(
    (day) => day.totalTokens === 0 || day.estimatedCostUSD !== null
  );
  return {
    days: covered.length,
    averageTokens: covered.reduce((total, day) => total + day.totalTokens, 0) / divisor,
    averageRequests: covered.reduce((total, day) => total + day.requests, 0) / divisor,
    averageCostUSD: costComplete && priced.length
      ? priced.reduce((total, value) => total + value, 0) / divisor
      : null
  };
}


export function baselinePercent(totalTokens: number, averageTokens: number): number | null {
  if (averageTokens <= 0) return null;
  return Math.round((totalTokens / averageTokens) * 100);
}

export function tokenComposition(totals: UsageTotals): TokenComposition {
  return {
    freshInput: totals.inputTokens,
    cacheRead: totals.cachedInputTokens,
    cacheCreated: totals.cacheCreationInputTokens,
    output: totals.outputTokens
  };
}

export function costPresentation(period: PeriodUsage): CostPresentation {
  const unpricedNote = period.totals.unpricedTokens > 0
    ? `${formatTokenCount(period.totals.unpricedTokens)} tokens have no list price`
    : null;
  const partialNote = period.partialProviders.length > 0
    ? `${joinNames(period.partialProviders)} history is partial`
    : null;
  if (period.totals.estimatedCostUSD === null) {
    const reason = partialNote
      ? `Cost hidden because ${partialNote}.`
      : unpricedNote
        ? `Cost hidden because ${unpricedNote}.`
        : "No verifiable cost is available for this selection.";
    return { label: "Cost estimate", detail: reason, unavailableReason: reason };
  }
  const basis = period.costBasis === "opencode_reported"
    ? { label: "OpenCode cost", detail: "Reported by OpenCode · may differ from your bill" }
    : period.costBasis === "mixed"
      ? { label: "Cost estimate", detail: "Mixed provider estimates · not your bill" }
      : { label: "API-rate estimate", detail: "Public API list rates · not your bill" };
  const notes = [unpricedNote, partialNote].filter((note): note is string => note !== null);
  return {
    label: basis.label,
    detail: notes.length > 0 ? `${notes.join(" · ")} · ${basis.detail}` : basis.detail,
    unavailableReason: null
  };
}

export function analyticsIssue(snapshot: DashboardSnapshot, scope: ProviderScope): AnalyticsIssue | null {
  const providers = providersForScope(snapshot, scope);
  const unavailable = providers.filter((provider) => provider.analytics?.status === "unavailable");
  const partial = providers.filter((provider) => provider.analytics?.status === "partial");
  if (unavailable.length > 0) {
    return {
      message: `${joinNames(unavailable.map((provider) => provider.name))} usage history is unavailable. Totals exclude that source.`,
      detail: analyticsDetail(unavailable),
      tone: "error"
    };
  }
  if (partial.length > 0) {
    return {
      message: `${joinNames(partial.map((provider) => provider.name))} usage history is partial. Token totals may be incomplete, and cost is hidden.`,
      detail: analyticsDetail(partial),
      tone: "warning"
    };
  }
  return null;
}

function analyticsDetail(providers: DashboardProvider[]): string | null {
  const reasons = providers
    .map((provider) => provider.analytics?.error?.message)
    .filter((message): message is string => typeof message === "string" && message.length > 0);
  return reasons.length > 0 ? [...new Set(reasons)].join(" ") : null;
}

export function previousPeriod(period: PeriodUsage): { startDay: string; endDay: string } {
  const length = inclusiveDayCount(period.startDay, period.endDay);
  return {
    startDay: shiftDay(period.startDay, -length),
    endDay: shiftDay(period.startDay, -1)
  };
}

export function percentageChange(current: number, previous: number): number | null {
  if (previous <= 0) return current > 0 ? null : 0;
  return Math.round(((current - previous) / previous) * 100);
}

export function peakUsageDay(days: UsageDay[]): UsageDay | null {
  let peak: UsageDay | null = null;
  for (const day of days) {
    if (!peak || day.totalTokens > peak.totalTokens) peak = day;
  }
  return peak?.totalTokens ? peak : null;
}

export function formatPeriodLabel(range: AnalyticsRange): string {
  if (range === "all") return "All available";
  if (range === 7) return "Last 7 days";
  if (range === 30) return "Last 30 days";
  return "Last 90 days";
}

function dayRange(startDay: string, endDay: string): string[] {
  if (startDay > endDay) return [];
  const count = Math.min(366, inclusiveDayCount(startDay, endDay));
  return Array.from({ length: count }, (_, index) => shiftDay(startDay, index));
}

function emptyUsage(): UsageDailyMetric {
  return {
    date: "",
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requests: 0,
    estimatedCostUSD: null,
    unpricedTokens: 0
  };
}

function parseDay(day: string): Date {
  return new Date(`${day}T12:00:00`);
}

function calendarDay(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function costBasis(providerIDs: string[]): CostBasis {
  const hasOpenCode = providerIDs.includes("opencode");
  const hasAPIEstimate = providerIDs.some((providerID) => providerID !== "opencode");
  if (hasOpenCode && hasAPIEstimate) return "mixed";
  return hasOpenCode ? "opencode_reported" : "api_equivalent";
}

function formatTokenCount(value: number): string {
  return tokenCountFormatter.format(value);
}

function joinNames(names: string[]): string {
  if (names.length < 2) return names[0] ?? "Selected provider";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

const tokenCountFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1
});
