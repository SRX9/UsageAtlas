import structural from "./usage-validator.cjs";

export type UsageProvider = "codex" | "claude" | "cursor" | "opencode";
export interface StoredTotals {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  estimatedCostMicrosUSD: number | null;
  unpricedTokens: number;
}
interface BaseRecord {
  schemaVersion: 1;
  recordId: string;
  sourceId: string;
  providerId: UsageProvider;
  observedAt: string;
}
export interface UsageDay extends BaseRecord {
  kind: "usage_day";
  breakdownCoverage?: { hourly: "complete" | "partial" | "unknown"; models: "complete" | "partial" | "unknown" };
  localDay: string;
  timeZone: string | null;
  dayState: "open" | "complete";
  collectionMethod: "local_activity" | "provider_history";
  status: "available" | "partial" | "no_data" | "unavailable";
  totals: StoredTotals | null;
  hourly: { localHour: number; utcStart: string | null; totals: StoredTotals }[] | null;
  models: { modelKey: string; totals: StoredTotals }[] | null;
}
export interface CapacitySnapshot extends BaseRecord {
  kind: "capacity_snapshot";
  status: "available" | "partial" | "unavailable";
  planKey:
    | "free"
    | "plus"
    | "pro"
    | "pro_plus"
    | "max"
    | "ultra"
    | "team"
    | "business"
    | "enterprise"
    | "other"
    | null;
  windows: {
    kind: "session" | "weekly" | "plan" | "auto" | "api" | "other";
    labelKey: "duration" | "session" | "weekly" | "plan" | "auto_composer" | "api" | "requests" | "other";
    durationMinutes: number | null;
    usedPercent: number;
    resetAt: string | null;
  }[];
}
export type UsageRecord = UsageDay | CapacitySnapshot;
export interface CloudRecord {
  record: UsageRecord;
  revision: number;
}
export interface PendingRecord extends CloudRecord {
  localVersion: number;
}
export interface SaveResult extends CloudRecord {
  status: "saved" | "conflict";
}
export const USAGE_BATCH_SIZE = 25;
export const USAGE_MAX_BYTES = 512 * 1024;

// Public display catalog only. Private saved records retain tool-reported identifiers.
export const PUBLIC_MODELS = new Set([
  "other",
  "auto",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5-codex",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-max",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "o3",
  "o4-mini",
  "claude-sonnet-4-20250514",
  "claude-opus-4-20250514",
  "claude-opus-4-1-20250805",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "composer-1",
  "composer-1.5",
  "composer-2",
  // Public model IDs and tool-reported variants, reviewed September 2026.
  // Keep exact matches: arbitrary/custom names must still remain on the device.
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "codex-auto-review",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-fable-5",
  "gemini-2.5-flash",
  "gemini-3.1-pro",
  "gemini-3.5-flash",
  "grok-4.5",
  "grok-4.6",
  "grok-4.7",
  "kimi-k3",
  "glm-5.2",
  "composer-2.5",
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
  "x-preview-f-free",
  "big-pickle",
  "cursor-grok-4.6-xhigh",
  "grok-bot-cua",
  "grok-bot-automation",
  "claude-opus-5-low",
  "kimi-k3-max",
  "cursor-grok-4.6-high",
  "grok-bot-default",
  "cursor-grok-4.6-high-fast",
  "cursor-grok-4.5-high",
  "claude-opus-5-thinking-low",
  "gpt-5.6-sol-xhigh",
  "cursor-grok-4.5-high-fast",
  "claude-4.5-sonnet",
  "gpt-5.5-high",
  "grok-4.5-xhigh",
  "claude-fable-5-thinking-high",
  "cursor-grok-4.5-medium",
  "claude-opus-4-8-thinking-high",
  "composer-2.5-fast",
  "cursor-grok-4.6-xhigh-fast",
  "claude-opus-5-thinking-xhigh",
  "gpt-5.5-extra-high",
  "glm-5.2-high",
  "kimi-k3-high",
  "gpt-5.6-luna-high",
  "gpt-5.6-sol-high",
  "gpt-5.6-sol-medium",
  "claude-opus-5-thinking-max"
]);

const countKeys = [
  "inputTokens",
  "cachedInputTokens",
  "cacheCreationInputTokens",
  "outputTokens",
  "totalTokens",
  "requests",
  "unpricedTokens"
] as const;

export function validateUsageRecord(value: unknown): UsageRecord {
  if (!structural(value)) throw new Error("Invalid usage record fields.");
  if (value.kind === "capacity_snapshot") return value;
  if (value.timeZone !== null) {
    if (/^[+-]/.test(value.timeZone)) throw new Error("Use an IANA reporting timezone.");
    new Intl.DateTimeFormat("en", { timeZone: value.timeZone });
  }
  if (
    value.status === "unavailable" &&
    (value.totals !== null || value.hourly !== null || value.models !== null)
  ) {
    throw new Error("Unavailable usage must have unknown totals and breakdowns.");
  }
  if (value.status !== "unavailable" && value.totals === null) throw new Error("Usage totals are required.");
  const totals = [
    value.totals,
    ...(value.hourly ?? []).map((row) => row.totals),
    ...(value.models ?? []).map((row) => row.totals)
  ];
  for (const total of totals) {
    if (!total) continue;
    if (
      total.totalTokens !==
        total.inputTokens + total.cachedInputTokens + total.cacheCreationInputTokens + total.outputTokens ||
      total.unpricedTokens > total.totalTokens
    )
      throw new Error("Usage totals are inconsistent.");
    if (
      value.status === "no_data" &&
      (countKeys.some((key) => total[key] !== 0) || (total.estimatedCostMicrosUSD ?? 0) !== 0)
    )
      throw new Error("No-data usage must be zero.");
  }
  const hours = new Set<string>();
  for (const hour of value.hourly ?? []) {
    const key = hour.utcStart ?? String(hour.localHour);
    if (hours.has(key)) throw new Error("Duplicate hour.");
    hours.add(key);
    if (hour.utcStart && value.timeZone) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: value.timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23"
      }).formatToParts(new Date(hour.utcStart));
      const part = (name: string) => parts.find((p) => p.type === name)?.value;
      if (
        `${part("year")}-${part("month")}-${part("day")}` !== value.localDay ||
        Number(part("hour")) !== hour.localHour
      )
        throw new Error("Hour does not match its reporting day.");
    }
  }
  const models = new Set<string>();
  for (const model of value.models ?? []) {
    if (models.has(model.modelKey))
      throw new Error("Duplicate model.");
    models.add(model.modelKey);
  }
  for (const rows of [value.hourly, value.models]) {
    if (!rows || !value.totals) continue;
    for (const key of countKeys) {
      if (rows.reduce((sum, row) => sum + row.totals[key], 0) > value.totals[key])
        throw new Error("Breakdowns exceed daily usage.");
    }
  }
  for (const axis of ["hourly", "models"] as const) {
    if (value.breakdownCoverage?.[axis] !== "complete") continue;
    if (!value[axis] || !value.totals || countKeys.some(key => value[axis]!.reduce((sum, row) => sum + row.totals[key], 0) !== value.totals![key]))
      throw new Error("Complete breakdowns must reconcile exactly.");
  }
  return value;
}

export function canonicalUsage(record: UsageRecord): string {
  return JSON.stringify(record, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value
  );
}

export function sameUsage(a: UsageRecord, b: UsageRecord): boolean {
  return canonicalUsage({ ...a, observedAt: b.observedAt }) === canonicalUsage(b);
}
