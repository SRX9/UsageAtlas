import type { UsageRecord } from "./local-usage";

export function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
export function counter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid token count.");
  return value;
}
export function sum(...values: number[]): number { return counter(values.reduce((total, value) => total + value, 0)); }
export function aliases(row: Record<string, unknown>, keys: string[], required = false): number {
  const values = keys.filter(key => row[key] !== undefined).map(key => counter(row[key]));
  if (values.some(value => value !== values[0]) || (required && !values.length)) throw new Error("Missing or conflicting token counts.");
  return values[0] ?? 0;
}
export function timestamp(value: unknown): string {
  const ms = typeof value === "number" ? counter(value) * (value < 100_000_000_000 ? 1000 : 1)
    : typeof value === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || ms <= 0 || ms > 253402300799999) throw new Error("Missing or invalid event timestamp.");
  return new Date(ms).toISOString();
}
export function localRecord(values: Pick<UsageRecord, "timestamp" | "model" | "sessionID" | "eventKey" | "inputTokens" | "cachedInputTokens" | "cacheCreationInputTokens" | "outputTokens"> & Partial<UsageRecord>): UsageRecord {
  if (!values.model || values.model.length > 256 || (values.reportedModel?.length ?? 0) > 256
    || (values.modelProvider?.length ?? 0) > 256) throw new Error("Unsupported model identifier.");
  return { day: values.timestamp.slice(0, 10), projectPath: null, projectLabel: "Unknown project", serviceTier: "",
    estimatedCostUSD: null, totalTokens: sum(values.inputTokens, values.cachedInputTokens, values.cacheCreationInputTokens, values.outputTokens),
    eventIdentity: "source", ...values };
}
