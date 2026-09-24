import type { StoredTotals, UsageProvider } from "./usage";
import structural from "./statistics-validator.cjs";

export const STATISTICS_BATCH_SIZE = 250;
export const STATISTICS_MAX_BYTES = 512 * 1024;
export const USAGE_PARSER_VERSION = "3";

/** Transient collector data. Paths and source keys are hashed before persistence to cloud. */
export interface CollectedUsageEvent {
  timestamp: string;
  day: string;
  model: string;
  reportedModel?: string;
  modelProvider?: string;
  sessionID: string;
  projectPath: string | null;
  projectLabel: string;
  serviceTier: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUSD: number | null;
  eventKey: string;
  eventIdentity?: "source" | "fingerprint";
  rawTokens?: Record<string, number | null>;
  reportedCostUSD?: number | null;
  pricingVersion?: string | null;
  granularity?: "event" | "session";
  measurement?: "known" | "unknown";
}
export interface UsageCollection {
  events: CollectedUsageEvent[];
  parserVersion: string;
  pricingVersion: string | null;
  timeZone: string;
  coverageStart: string;
  coverageEnd: string;
  status: "available" | "partial" | "no_data" | "unavailable";
  filesScanned: number;
  recordsProcessed: number;
  reasonCode: string | null;
}
interface FactBase {
  schemaVersion: 1;
  id: string;
  sourceId: string;
  providerId: UsageProvider;
  observedAt: string;
}
export interface UsageEventFact extends FactBase {
  kind: "usage_event";
  eventId: string;
  eventIdentity: "source" | "fingerprint";
  occurredAt: string;
  timeZone: string;
  modelKey: string;
  reportedModel: string;
  modelProvider: string | null;
  sessionId: string | null;
  projectId: string | null;
  serviceTier: string | null;
  granularity: "event" | "session";
  measurement: "known" | "unknown";
  totals: StoredTotals | null;
  rawTokens: Record<string, number | null>;
  reportedCostUSD: number | null;
  estimatedCostUSD: number | null;
  pricingVersion: string | null;
  parserVersion: string;
}
export interface CollectionFact extends FactBase {
  kind: "collection";
  timeZone: string;
  coverageStart: string;
  coverageEnd: string;
  status: UsageCollection["status"];
  filesScanned: number;
  recordsProcessed: number;
  reasonCode: string | null;
  parserVersion: string;
  pricingVersion: string | null;
}
export interface CapacityFact extends FactBase {
  kind: "capacity";
  plan: string | null;
  windows: { kind: string; label: string; usedPercent: number; resetAt: string | null }[];
  credits: { remaining: number; unit: string } | null;
}
export type UsageFact = UsageEventFact | CollectionFact | CapacityFact;

/** Event identity ignores observation time, so rescanning unchanged history is idempotent. */
export function factContent(fact: UsageFact): string {
  return JSON.stringify({ ...fact, id: "", observedAt: fact.kind === "usage_event" ? "" : fact.observedAt },
    (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
}
const timeZones = new Set<string>();
export function validateUsageFact(value: unknown): UsageFact {
  if (!structural(value)) throw new Error("Invalid usage observation.");
  if (value.kind === "capacity") return value;
  if (/^[+-]/.test(value.timeZone)) throw new Error("Use an IANA reporting timezone.");
  if (!timeZones.has(value.timeZone)) {
    new Intl.DateTimeFormat("en", { timeZone: value.timeZone });
    if (timeZones.size >= 128) timeZones.clear();
    timeZones.add(value.timeZone);
  }
  if (value.kind === "collection") {
    if (value.coverageStart > value.coverageEnd) throw new Error("Invalid collection coverage.");
    return value;
  }
  if ((value.measurement === "known") !== (value.totals !== null)) throw new Error("Unknown measurements must have null totals.");
  if (value.totals) {
    const t = value.totals;
    if (t.totalTokens !== t.inputTokens + t.cachedInputTokens + t.cacheCreationInputTokens + t.outputTokens
      || t.unpricedTokens > t.totalTokens || t.requests !== 1) throw new Error("Invalid observation totals.");
  }
  return value;
}
