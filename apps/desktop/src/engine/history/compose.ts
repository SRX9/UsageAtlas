import {
  HISTORY_LOCAL_ACCOUNT_KEY,
  type HistoryDayRecord,
  type LocalUsageAnalytics,
  type UsageDailyMetric,
  type UsageDailyModelMetric
} from "@usageatlas/contracts";
import { dayRange, localCalendarDay, shiftLocalDay } from "./days";
import {
  emptyUsageTotals,
  isEmptyHistoryPayload,
  mergeBreakdowns,
  mergeHourly,
  mergeProjects,
  mergeSessions,
  sumUsageTotals
} from "./payload";

const MAX_PROJECTS = 200;
const MAX_SESSIONS = 250;
const MAX_DAILY_MODELS = 5_000;
const MAX_MODELS = 200;
const MAX_SERVICE_TIERS = 10;

export function composeProviderAnalytics(options: {
  now: Date;
  stored: HistoryDayRecord[];
  liveToday: LocalUsageAnalytics | null;
  currentAccountKey: string;
  historyDays: number;
}): LocalUsageAnalytics {
  const today = localCalendarDay(options.now);
  const coverageEnd = today;
  const requestedStart = shiftLocalDay(coverageEnd, -(options.historyDays - 1));
  const liveUsable = options.liveToday
    && (options.liveToday.status === "available" || options.liveToday.status === "partial")
    ? options.liveToday
    : null;
  const liveTodayTotals = liveUsable ? dayTotalsFromAnalytics(liveUsable, today) : null;
  const byDay = new Map<string, HistoryDayRecord[]>();
  for (const row of options.stored) {
    if (row.localDay < requestedStart || row.localDay > coverageEnd) continue;
    if (isEmptyHistoryPayload(row.payload)) continue;
    if (row.localDay === today && row.accountKey === options.currentAccountKey && liveTodayTotals) {
      continue;
    }
    const group = byDay.get(row.localDay) ?? [];
    group.push(row);
    byDay.set(row.localDay, group);
  }

  const daily: UsageDailyMetric[] = [];
  const hourly = [];
  const models = [];
  const dailyModels: UsageDailyModelMetric[] = [];
  const projects = [];
  const sessions = [];
  const serviceTiers = [];
  let storedProjects: LocalUsageAnalytics["projects"] = [];
  let storedSessions: LocalUsageAnalytics["sessions"] = [];
  let storedServiceTiers: LocalUsageAnalytics["serviceTiers"] = [];
  let filesScanned = 0;
  let recordsProcessed = 0;
  let analyticsSource: LocalUsageAnalytics["source"] = liveUsable?.source ?? "local_sessions";
  let status: LocalUsageAnalytics["status"] = "no_data";
  let error: LocalUsageAnalytics["error"] = null;

  for (const day of dayRange(requestedStart, coverageEnd)) {
    const rows = byDay.get(day) ?? [];
    const liveSlice = day === today ? liveTodayTotals : null;
    const totalsList = [
      ...rows.map((row) => row.payload.totals),
      ...(liveSlice ? [liveSlice] : [])
    ];
    if (totalsList.length === 0) continue;
    const totals = sumUsageTotals(totalsList);
    daily.push({ date: day, ...totals });
    for (const row of rows) {
      hourly.push(...row.payload.hourly);
      models.push(...row.payload.models);
      for (const model of row.payload.models) {
        dailyModels.push({ date: day, ...model });
      }
      if (!liveUsable) {
        if (row.payload.projects.length > 0) storedProjects = row.payload.projects;
        if (row.payload.sessions.length > 0) storedSessions = row.payload.sessions;
        if (row.payload.serviceTiers.length > 0) storedServiceTiers = row.payload.serviceTiers;
      }
      filesScanned = Math.max(filesScanned, row.payload.filesScanned);
      recordsProcessed += row.payload.recordsProcessed;
      analyticsSource = row.payload.analyticsSource;
      if (row.payload.status === "partial" || row.payload.status === "unavailable") {
        status = row.payload.status === "unavailable" && status === "no_data"
          ? "unavailable"
          : "partial";
        error = row.payload.error ?? error;
      } else if (status === "no_data") {
        status = "available";
      }
    }
    if (liveSlice && liveUsable) {
      hourly.push(...(liveUsable.hourly ?? []).filter((entry) => entry.date === today));
      for (const model of liveUsable.dailyModels.filter((entry) => entry.date === today)) {
        models.push(model);
        dailyModels.push(model);
      }
      filesScanned = Math.max(filesScanned, liveUsable.filesScanned);
      recordsProcessed += liveUsable.recordsProcessed;
      analyticsSource = liveUsable.source;
      if (liveUsable.status === "partial" || liveUsable.status === "unavailable") {
        status = liveUsable.status === "unavailable" && status === "no_data"
          ? "unavailable"
          : "partial";
        error = liveUsable.error ?? error;
      } else if (status === "no_data" || status === "unavailable") {
        status = liveUsable.status;
      }
    }
  }

  if (liveUsable) {
    projects.push(...liveUsable.projects);
    sessions.push(...liveUsable.sessions);
    serviceTiers.push(...liveUsable.serviceTiers);
  } else {
    projects.push(...storedProjects);
    sessions.push(...storedSessions);
    serviceTiers.push(...storedServiceTiers);
  }

  if (daily.length === 0 && liveUsable) {
    return {
      ...liveUsable,
      historyDays: options.historyDays
    };
  }

  const coverageStart = daily[0]?.date ?? requestedStart;
  const todayTotals = daily.find((entry) => entry.date === today);
  const trimmedDailyModels = dailyModels
    .sort(compareUsage)
    .slice(0, MAX_DAILY_MODELS)
    .sort((left, right) => left.date.localeCompare(right.date) || compareUsage(left, right));

  return {
    status: daily.length === 0 ? (status === "no_data" ? "no_data" : status) : (status === "no_data" ? "available" : status),
    source: analyticsSource,
    historyDays: options.historyDays,
    coverageStart,
    coverageEnd,
    updatedAt: options.now.toISOString(),
    filesScanned,
    recordsProcessed,
    totals: sumUsageTotals(daily),
    today: todayTotals
      ? {
          inputTokens: todayTotals.inputTokens,
          cachedInputTokens: todayTotals.cachedInputTokens,
          cacheCreationInputTokens: todayTotals.cacheCreationInputTokens,
          outputTokens: todayTotals.outputTokens,
          totalTokens: todayTotals.totalTokens,
          requests: todayTotals.requests,
          estimatedCostUSD: todayTotals.estimatedCostUSD,
          unpricedTokens: todayTotals.unpricedTokens
        }
      : emptyUsageTotals(),
    daily,
    hourly: mergeHourly(hourly),
    models: mergeBreakdowns(models, MAX_MODELS),
    dailyModels: trimmedDailyModels,
    projects: mergeProjects(projects, MAX_PROJECTS),
    sessions: mergeSessions(sessions, MAX_SESSIONS),
    serviceTiers: mergeBreakdowns(serviceTiers, MAX_SERVICE_TIERS),
    error
  };
}

export function resolveAccountKey(value: string | undefined | null): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed.slice(0, 128) : HISTORY_LOCAL_ACCOUNT_KEY;
}

function dayTotalsFromAnalytics(analytics: LocalUsageAnalytics, day: string) {
  const entry = analytics.daily.find((row) => row.date === day);
  const totals = entry
    ? {
        inputTokens: entry.inputTokens,
        cachedInputTokens: entry.cachedInputTokens,
        cacheCreationInputTokens: entry.cacheCreationInputTokens,
        outputTokens: entry.outputTokens,
        totalTokens: entry.totalTokens,
        requests: entry.requests,
        estimatedCostUSD: entry.estimatedCostUSD,
        unpricedTokens: entry.unpricedTokens
      }
    : analytics.today;
  if (totals.totalTokens === 0 && totals.requests === 0) return null;
  return totals;
}

function compareUsage(
  left: { estimatedCostUSD: number | null; totalTokens: number },
  right: { estimatedCostUSD: number | null; totalTokens: number }
): number {
  const costDifference = (right.estimatedCostUSD ?? -1) - (left.estimatedCostUSD ?? -1);
  return costDifference || right.totalTokens - left.totalTokens;
}
