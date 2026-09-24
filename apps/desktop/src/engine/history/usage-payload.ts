import { createHash } from "node:crypto";
import type { HistoryDayPayload, HistoryDayRecord, UsageTotals } from "@usageatlas/contracts";
import {
  validateUsageRecord,
  type UsageDay,
  type UsageProvider,
  type StoredTotals,
  type CapacitySnapshot
} from "@usageatlas/contracts/usage";
import { emptyUsageTotals, sumUsageTotals } from "./payload";

export function stableId(...parts: string[]): string {
  const hash = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function usageSource(replica: string, provider: string, account: string): string {
  return stableId("usageatlas", provider, account === "local" ? replica : account);
}
export function toUsageDay(row: HistoryDayRecord, replica: string, timeZone: string | null): UsageDay {
  const sourceId = usageSource(replica, row.providerId, row.accountKey);
  const groups = new Map<string, UsageTotals[]>();
  for (const model of row.payload.models) {
    const key = model.id;
    groups.set(key, [...(groups.get(key) ?? []), model]);
  }
  return {
    schemaVersion: 1,
    recordId: stableId(sourceId, row.localDay),
    sourceId,
    providerId: row.providerId as UsageProvider,
    kind: "usage_day",
    localDay: row.localDay,
    timeZone,
    dayState: row.sealed ? "complete" : "open",
    observedAt: row.payload.capturedAt,
    collectionMethod: row.payload.analyticsSource === "remote_usage" ? "provider_history" : "local_activity",
    status: row.payload.status,
    breakdownCoverage: {
      hourly: coverage(row.payload.hourly, row.payload.totals, row.payload.status),
      models: coverage(row.payload.models, row.payload.totals, row.payload.status)
    },
    totals: row.payload.status === "unavailable" ? null : storedTotals(row.payload.totals),
    hourly:
      row.payload.status === "unavailable"
        ? null
        : row.payload.hourly
            .map((hour) => ({ localHour: hour.hour, utcStart: hour.utcStart ?? null, totals: storedTotals(hour) }))
            .sort((a, b) => a.localHour - b.localHour),
    models:
      row.payload.status === "unavailable"
        ? null
        : [...groups]
            .map(([modelKey, values]) => ({ modelKey, totals: storedTotals(sumUsageTotals(values)) }))
            .sort((a, b) => a.modelKey.localeCompare(b.modelKey))
  };
}
/** Preview recovered labels without writing local history or saving to the cloud. */
export function previewModelRecovery(record: UsageDay, details: HistoryDayPayload): UsageDay | null {
  if (!record.models?.some((model) => model.modelKey === "other") || !record.totals) return null;
  try {
    const row = fromUsageDay(record, 0, details);
    const candidate = toUsageDay({ ...row, payload: { ...row.payload, models: details.models } }, "model-recovery", record.timeZone);
    if (!candidate.models || !candidate.totals) return null;
    const totals = record.totals;
    const localTotals = storedTotals(details.totals);
    if ((Object.keys(totals) as (keyof StoredTotals)[]).some((key) => totals[key] !== localTotals[key])) return null;
    // Preserve named models and reject partial or stale local breakdowns.
    for (const model of record.models.filter((entry) => entry.modelKey !== "other")) {
      const match = candidate.models.find((entry) => entry.modelKey === model.modelKey);
      if (!match || (Object.keys(model.totals) as (keyof StoredTotals)[]).some((key) => model.totals[key] !== match.totals[key])) return null;
    }
    const counts = ["inputTokens", "cachedInputTokens", "cacheCreationInputTokens", "outputTokens", "totalTokens", "requests", "unpricedTokens"] as const;
    if (counts.some((key) => record.models!.reduce((sum, row) => sum + row.totals[key], 0) !== candidate.models!.reduce((sum, row) => sum + row.totals[key], 0))) return null;
    const unknown = (models: NonNullable<UsageDay["models"]>) => models.find((model) => model.modelKey === "other")?.totals.totalTokens ?? 0;
    if (unknown(candidate.models) >= unknown(record.models)) return null;
    const recovered = { ...record, models: candidate.models };
    validateUsageRecord(recovered);
    return recovered;
  } catch {
    return null;
  }
}

export function toCapacity(row: HistoryDayRecord, replica: string): CapacitySnapshot | null {
  if (!row.payload.windows.length && !row.payload.identity?.plan) return null;
  const sourceId = usageSource(replica, row.providerId, row.accountKey);
  const plan = row.payload.identity?.plan?.toLowerCase().trim()
    .replace(/^cursor\s+/, "").replace(/\+$/, " plus").replace(/\s+/g, "_");
  const plans = ["free", "plus", "pro", "pro_plus", "max", "ultra", "team", "business", "enterprise"];
  return {
    schemaVersion: 1,
    recordId: stableId(sourceId, "capacity"),
    sourceId,
    providerId: row.providerId as UsageProvider,
    kind: "capacity_snapshot",
    observedAt: row.payload.capturedAt,
    status: "available",
    planKey: plan ? (plans.includes(plan) ? (plan as CapacitySnapshot["planKey"]) : "other") : null,
    windows: row.payload.windows.slice(0, 16).map((window) => {
      const kinds = ["session", "weekly", "plan", "auto", "api"];
      const kind = kinds.includes(window.kind)
        ? (window.kind as CapacitySnapshot["windows"][number]["kind"])
        : "other";
      const duration = /^(\d+)\s*(h|hour|hours|m|min|minutes|d|day|days)$/i.exec(window.label.trim());
      return {
        kind,
        labelKey: duration ? "duration" : kind === "auto" ? "auto_composer" : kind,
        durationMinutes: duration
          ? Number(duration[1]) * (/^h/i.test(duration[2]) ? 60 : /^d/i.test(duration[2]) ? 1440 : 1)
          : null,
        usedPercent: window.usedPercent,
        resetAt: window.resetAt ?? null
      };
    })
  };
}
export function fromUsageDay(
  record: UsageDay,
  version: number,
  details: HistoryDayPayload | null,
  accountKey = record.sourceId
): HistoryDayRecord {
  const totals = displayTotals(record.totals);
  return {
    id: record.recordId,
    providerId: record.providerId,
    accountKey: details?.accountKey ?? accountKey,
    localDay: record.localDay,
    sealed: record.dayState === "complete",
    changeSeq: version,
    updatedAt: record.observedAt,
    payload: {
      payloadVersion: 1,
      timeZone: record.timeZone ?? undefined,
      accountKey: details?.accountKey ?? accountKey,
      windows: details?.windows ?? [],
      identity: details?.identity ?? null,
      credits: details?.credits ?? null,
      source: details?.source ?? "cloud_history",
      capturedAt: record.observedAt,
      status: record.status,
      analyticsSource: record.collectionMethod === "provider_history" ? "remote_usage" : "local_sessions",
      totals,
      hourly: (record.hourly ?? []).map((hour) => ({
        date: record.localDay,
        hour: hour.localHour,
        utcStart: hour.utcStart,
        ...displayTotals(hour.totals)
      })),
      models:
        (record.models ?? []).map((model) => ({
          id: model.modelKey,
          label: model.modelKey,
          ...displayTotals(model.totals)
        })),
      projects: details?.projects ?? [],
      sessions: details?.sessions ?? [],
      serviceTiers: details?.serviceTiers ?? [],
      filesScanned: details?.filesScanned ?? 0,
      recordsProcessed: details?.recordsProcessed ?? 0,
      error: details?.error ?? null
    }
  };
}
function storedTotals(totals: UsageTotals): StoredTotals {
  return {
    inputTokens: totals.inputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    cacheCreationInputTokens: totals.cacheCreationInputTokens,
    outputTokens: totals.outputTokens,
    totalTokens: totals.totalTokens,
    requests: totals.requests,
    unpricedTokens: totals.unpricedTokens,
    estimatedCostMicrosUSD:
      totals.estimatedCostUSD === null ? null : Math.round(totals.estimatedCostUSD * 1_000_000)
  };
}
function displayTotals(totals: StoredTotals | null): UsageTotals {
  if (!totals) return emptyUsageTotals();
  const { estimatedCostMicrosUSD, ...counts } = totals;
  return {
    ...counts,
    estimatedCostUSD: estimatedCostMicrosUSD === null ? null : estimatedCostMicrosUSD / 1_000_000
  };
}

function coverage(rows: UsageTotals[], totals: UsageTotals, status: string): "complete" | "partial" | "unknown" {
  if (status === "unavailable") return "unknown";
  const keys = ["inputTokens", "cachedInputTokens", "cacheCreationInputTokens", "outputTokens", "totalTokens", "requests", "unpricedTokens"] as const;
  return keys.every(key => rows.reduce((sum, row) => sum + row[key], 0) === totals[key]) ? "complete" : rows.length ? "partial" : "unknown";
}
