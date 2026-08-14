import type {
  DashboardProvider,
  DashboardSnapshot,
  DashboardWindow,
  UsageDailyMetric,
  UsageTotals
} from "@usageatlas/contracts";

export interface DashboardSummary {
  connectedProviders: number;
  attentionProviders: number;
  averageUsedPercent: number | null;
  highestUsageProvider: DashboardProvider | null;
  todayTokens: number;
  totalTokens: number;
  totalRequests: number;
  estimatedCostUSD: number | null;
}

export interface UsageCalendarDay {
  date: string;
  totalTokens: number;
  covered: boolean;
}

export interface TopProject {
  id: string;
  label: string;
  providerNames: string[];
  totalTokens: number;
  requests: number;
  estimatedCostUSD: number | null;
}


export function buildDashboardSummary(snapshot: DashboardSnapshot): DashboardSummary {
  const healthy = snapshot.providers.filter((provider) => provider.enabled && !provider.error);
  const percentages = healthy.flatMap((provider) => provider.windows.map((window) => window.usedPercent));
  const providersWithUsage = healthy.filter((provider) => provider.windows.length > 0);
  const highestUsageProvider = providersWithUsage.reduce<DashboardProvider | null>((highest, provider) => {
    if (!highest) return provider;
    return maximumUsage(provider) > maximumUsage(highest) ? provider : highest;
  }, null);
  const analytics = snapshot.providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) => provider.analytics?.status === "available" || provider.analytics?.status === "partial"
      ? [provider.analytics]
      : []);
  const analyticsTotals = sumUsageTotals(analytics.map((item) => item.totals));

  return {
    connectedProviders: healthy.length,
    attentionProviders: snapshot.providers.filter((provider) => provider.enabled && Boolean(provider.error)).length,
    averageUsedPercent: percentages.length
      ? Math.round(percentages.reduce((total, value) => total + value, 0) / percentages.length)
      : null,
    highestUsageProvider,
    todayTokens: analytics.reduce((total, item) => total + item.today.totalTokens, 0),
    totalTokens: analytics.reduce((total, item) => total + item.totals.totalTokens, 0),
    totalRequests: analytics.reduce((total, item) => total + item.totals.requests, 0),
    estimatedCostUSD: analyticsTotals.estimatedCostUSD
  };
}

export function buildUsageCalendar(snapshot: DashboardSnapshot, days = 365): UsageCalendarDay[] {
  const analytics = snapshot.providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) => provider.analytics?.status === "available" || provider.analytics?.status === "partial"
      ? [provider.analytics]
      : []);
  const fallbackDay = snapshot.generatedAt.slice(0, 10);
  const coverageEnd = analytics.reduce(
    (latest, item) => item.coverageEnd > latest ? item.coverageEnd : latest,
    fallbackDay
  );
  const coverageStart = analytics.reduce(
    (earliest, item) => item.coverageStart < earliest ? item.coverageStart : earliest,
    coverageEnd
  );
  const tokensByDay = new Map<string, number>();
  for (const item of analytics) {
    for (const day of item.daily) {
      tokensByDay.set(day.date, (tokensByDay.get(day.date) ?? 0) + day.totalTokens);
    }
  }

  const end = new Date(`${coverageEnd}T12:00:00`);
  const rangeDays = Math.max(1, days);
  const start = new Date(end);
  start.setDate(start.getDate() - (rangeDays - 1));

  return Array.from({ length: rangeDays }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const day = localDay(date);
    return {
      date: day,
      totalTokens: tokensByDay.get(day) ?? 0,
      covered: day >= coverageStart && day <= coverageEnd
    };
  });
}

export function buildTopProjects(snapshot: DashboardSnapshot, limit = 5): TopProject[] {
  const projects = new Map<string, TopProject>();
  for (const provider of snapshot.providers) {
    if (!provider.enabled || provider.analytics?.source !== "local_sessions") continue;
    for (const project of provider.analytics.projects) {
      const id = project.path ?? project.id;
      const current = projects.get(id) ?? {
        id,
        label: project.label,
        providerNames: [],
        totalTokens: 0,
        requests: 0,
        estimatedCostUSD: null
      };
      if (!current.providerNames.includes(provider.name)) current.providerNames.push(provider.name);
      current.totalTokens += project.totalTokens;
      current.requests += project.requests;
      if (provider.analytics.status === "partial") {
        projects.set(id, current);
        continue;
      }
      if (project.estimatedCostUSD !== null) {
        current.estimatedCostUSD = (current.estimatedCostUSD ?? 0) + project.estimatedCostUSD;
      }
      projects.set(id, current);
    }
  }

  return [...projects.values()]
    .sort((left, right) => right.totalTokens - left.totalTokens)
    .slice(0, Math.max(0, limit));
}

export function usageDaysForRange(daily: UsageDailyMetric[], days: number, endDay: string): UsageDailyMetric[] {
  const end = new Date(`${endDay}T12:00:00`);
  end.setDate(end.getDate() - (Math.max(1, days) - 1));
  const startDay = localDay(end);
  return daily.filter((entry) => entry.date >= startDay && entry.date <= endDay);
}

export function sumUsageTotals(entries: UsageTotals[]): UsageTotals {
  const costs = entries.map((entry) => entry.estimatedCostUSD).filter((value): value is number => value !== null);
  const unpricedTokens = entries.reduce((total, entry) => total + entry.unpricedTokens, 0);
  return {
    inputTokens: entries.reduce((total, entry) => total + entry.inputTokens, 0),
    cachedInputTokens: entries.reduce((total, entry) => total + entry.cachedInputTokens, 0),
    cacheCreationInputTokens: entries.reduce((total, entry) => total + entry.cacheCreationInputTokens, 0),
    outputTokens: entries.reduce((total, entry) => total + entry.outputTokens, 0),
    totalTokens: entries.reduce((total, entry) => total + entry.totalTokens, 0),
    requests: entries.reduce((total, entry) => total + entry.requests, 0),
    estimatedCostUSD: costs.length ? costs.reduce((total, value) => total + value, 0) : null,
    unpricedTokens
  };
}

export function maximumUsage(provider: DashboardProvider): number {
  return provider.windows.reduce((maximum, window) => Math.max(maximum, window.usedPercent), 0);
}

export function isSnapshotStale(snapshot: DashboardSnapshot, now = Date.now()): boolean {
  const generated = Date.parse(snapshot.generatedAt);
  return !Number.isFinite(generated) || now - generated > snapshot.staleAfterSeconds * 1_000;
}

export function formatReset(window: DashboardWindow, now = Date.now()): string {
  if (!window.resetAt) return "No reset time";
  const difference = Date.parse(window.resetAt) - now;
  if (!Number.isFinite(difference) || difference <= 0) return "Reset due";
  const minutes = Math.max(1, Math.round(difference / 60_000));
  if (minutes < 60) return `Resets in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Resets in ${hours}h`;
  return `Resets in ${Math.round(hours / 24)}d`;
}

function localDay(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
