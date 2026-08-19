import {
  HISTORY_DAY_PAYLOAD_VERSION,
  type HistoryDayPayload,
  type UsageBreakdown,
  type UsageDailyModelMetric,
  type UsageHourlyMetric,
  type UsageProjectBreakdown,
  type UsageSessionBreakdown,
  type UsageTotals
} from "@usageatlas/contracts";
import type { LocalUsageAnalytics } from "@usageatlas/contracts";

export function emptyUsageTotals(): UsageTotals {
  return {
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

export function readHistoryDayPayload(text: string): HistoryDayPayload | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isHistoryDayPayload(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function isHistoryDayPayload(value: unknown): value is HistoryDayPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as HistoryDayPayload;
  return payload.totals != null
    && typeof payload.totals === "object"
    && typeof payload.totals.totalTokens === "number"
    && typeof payload.totals.requests === "number"
    && Array.isArray(payload.windows)
    && Array.isArray(payload.hourly)
    && Array.isArray(payload.models)
    && Array.isArray(payload.projects)
    && Array.isArray(payload.sessions)
    && Array.isArray(payload.serviceTiers);
}

export function isEmptyHistoryPayload(payload: HistoryDayPayload): boolean {
  return payload.totals.totalTokens === 0
    && payload.totals.requests === 0
    && payload.windows.length === 0
    && payload.hourly.every((entry) => entry.totalTokens === 0 && entry.requests === 0);
}

export function hasUsageTotals(payload: HistoryDayPayload): boolean {
  return payload.totals.totalTokens > 0
    || payload.totals.requests > 0
    || payload.hourly.some((entry) => entry.totalTokens > 0 || entry.requests > 0);
}

/** Sealed rows stay put unless they were empty or a partial scan that a later scan improves. */
export function canReplaceSealed(existing: HistoryDayPayload, incoming: HistoryDayPayload): boolean {
  if (isEmptyHistoryPayload(incoming)) return false;
  if (isEmptyHistoryPayload(existing)) return true;
  if (existing.status !== "partial") return false;
  if (incoming.status === "available") return true;
  return incoming.totals.totalTokens > existing.totals.totalTokens
    || incoming.totals.requests > existing.totals.requests;
}

export function sumUsageTotals(entries: UsageTotals[]): UsageTotals {
  const costs = entries
    .map((entry) => entry.estimatedCostUSD)
    .filter((value): value is number => value !== null);
  return {
    inputTokens: entries.reduce((total, entry) => total + entry.inputTokens, 0),
    cachedInputTokens: entries.reduce((total, entry) => total + entry.cachedInputTokens, 0),
    cacheCreationInputTokens: entries.reduce((total, entry) => total + entry.cacheCreationInputTokens, 0),
    outputTokens: entries.reduce((total, entry) => total + entry.outputTokens, 0),
    totalTokens: entries.reduce((total, entry) => total + entry.totalTokens, 0),
    requests: entries.reduce((total, entry) => total + entry.requests, 0),
    estimatedCostUSD: costs.length ? costs.reduce((total, value) => total + value, 0) : null,
    unpricedTokens: entries.reduce((total, entry) => total + entry.unpricedTokens, 0)
  };
}

export function extractDayPayload(
  analytics: LocalUsageAnalytics,
  day: string,
  options: {
    accountKey: string;
    windows: HistoryDayPayload["windows"];
    identity: HistoryDayPayload["identity"];
    credits: HistoryDayPayload["credits"];
    source: string;
    capturedAt: string;
    includeCoverageWideBreakdowns: boolean;
  }
): HistoryDayPayload {
  const dayTotals = analytics.daily.find((entry) => entry.date === day);
  const totals = dayTotals
    ? {
        inputTokens: dayTotals.inputTokens,
        cachedInputTokens: dayTotals.cachedInputTokens,
        cacheCreationInputTokens: dayTotals.cacheCreationInputTokens,
        outputTokens: dayTotals.outputTokens,
        totalTokens: dayTotals.totalTokens,
        requests: dayTotals.requests,
        estimatedCostUSD: dayTotals.estimatedCostUSD,
        unpricedTokens: dayTotals.unpricedTokens
      }
    : emptyUsageTotals();
  const hourly = (analytics.hourly ?? []).filter((entry) => entry.date === day);
  const models = modelsForDay(analytics.dailyModels, day);
  return {
    payloadVersion: HISTORY_DAY_PAYLOAD_VERSION,
    accountKey: options.accountKey,
    windows: options.windows,
    identity: options.identity,
    credits: options.credits,
    source: options.source,
    capturedAt: options.capturedAt,
    status: analytics.status,
    analyticsSource: analytics.source,
    totals,
    hourly,
    models,
    projects: options.includeCoverageWideBreakdowns ? analytics.projects : [],
    sessions: options.includeCoverageWideBreakdowns ? analytics.sessions : [],
    serviceTiers: options.includeCoverageWideBreakdowns ? analytics.serviceTiers : [],
    filesScanned: analytics.filesScanned,
    recordsProcessed: analytics.recordsProcessed,
    error: analytics.error
  };
}

function modelsForDay(dailyModels: UsageDailyModelMetric[], day: string): UsageBreakdown[] {
  return dailyModels
    .filter((row) => row.date === day)
    .map((row) => ({
      id: row.id,
      label: row.label,
      inputTokens: row.inputTokens,
      cachedInputTokens: row.cachedInputTokens,
      cacheCreationInputTokens: row.cacheCreationInputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.totalTokens,
      requests: row.requests,
      estimatedCostUSD: row.estimatedCostUSD,
      unpricedTokens: row.unpricedTokens
    }))
    .sort(compareUsage);
}

export function mergeHourly(entries: UsageHourlyMetric[]): UsageHourlyMetric[] {
  const groups = new Map<string, UsageHourlyMetric[]>();
  for (const entry of entries) {
    const key = `${entry.date}T${String(entry.hour).padStart(2, "0")}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, group]) => ({
      date: key.slice(0, 10),
      hour: Number(key.slice(11)),
      ...sumUsageTotals(group)
    }));
}

export function mergeBreakdowns(entries: UsageBreakdown[], limit: number): UsageBreakdown[] {
  const groups = new Map<string, { label: string; totals: UsageTotals[] }>();
  for (const entry of entries) {
    const group = groups.get(entry.id) ?? { label: entry.label, totals: [] };
    group.totals.push(entry);
    groups.set(entry.id, group);
  }
  return [...groups.entries()]
    .map(([id, group]) => ({ id, label: group.label, ...sumUsageTotals(group.totals) }))
    .sort(compareUsage)
    .slice(0, limit);
}

export function mergeProjects(entries: UsageProjectBreakdown[], limit: number): UsageProjectBreakdown[] {
  const groups = new Map<string, {
    label: string;
    path: string | null;
    modelIDs: Set<string>;
    totals: UsageTotals[];
  }>();
  for (const entry of entries) {
    const group = groups.get(entry.id) ?? {
      label: entry.label,
      path: entry.path,
      modelIDs: new Set<string>(),
      totals: []
    };
    group.path = group.path ?? entry.path;
    for (const modelID of entry.modelIDs) group.modelIDs.add(modelID);
    group.totals.push(entry);
    groups.set(entry.id, group);
  }
  return [...groups.entries()]
    .map(([id, group]) => ({
      id,
      label: group.label,
      path: group.path,
      modelIDs: [...group.modelIDs].sort(),
      ...sumUsageTotals(group.totals)
    }))
    .sort(compareUsage)
    .slice(0, limit);
}

export function mergeSessions(entries: UsageSessionBreakdown[], limit: number): UsageSessionBreakdown[] {
  const groups = new Map<string, {
    label: string;
    lastActivity: string;
    project: string | null;
    modelIDs: Set<string>;
    totals: UsageTotals[];
  }>();
  for (const entry of entries) {
    const group = groups.get(entry.id) ?? {
      label: entry.label,
      lastActivity: entry.lastActivity,
      project: entry.project,
      modelIDs: new Set<string>(),
      totals: []
    };
    if (entry.lastActivity > group.lastActivity) group.lastActivity = entry.lastActivity;
    group.project = group.project ?? entry.project;
    for (const modelID of entry.modelIDs) group.modelIDs.add(modelID);
    group.totals.push(entry);
    groups.set(entry.id, group);
  }
  return [...groups.entries()]
    .map(([id, group]) => ({
      id,
      label: group.label,
      lastActivity: group.lastActivity,
      project: group.project,
      modelIDs: [...group.modelIDs].sort(),
      ...sumUsageTotals(group.totals)
    }))
    .sort((left, right) => right.lastActivity.localeCompare(left.lastActivity))
    .slice(0, limit);
}

function compareUsage(left: UsageTotals, right: UsageTotals): number {
  const costDifference = (right.estimatedCostUSD ?? -1) - (left.estimatedCostUSD ?? -1);
  return costDifference || right.totalTokens - left.totalTokens;
}
