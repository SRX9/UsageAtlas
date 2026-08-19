export const DASHBOARD_SCHEMA_VERSION = 2 as const;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ProviderFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface DashboardWindow {
  kind: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetAt?: string | null;
}

export interface UsageTotals {
  /** Fresh, non-cached input. Token categories are mutually exclusive. */
  inputTokens: number;
  /** Cache-read input. */
  cachedInputTokens: number;
  /** Cache-write/cache-creation input. */
  cacheCreationInputTokens: number;
  outputTokens: number;
  /** Sum of fresh input, cache read, cache creation, and output tokens. */
  totalTokens: number;
  requests: number;
  estimatedCostUSD: number | null;
  unpricedTokens: number;
}

export interface UsageDailyMetric extends UsageTotals {
  date: string;
}

export interface UsageHourlyMetric extends UsageTotals {
  date: string;
  hour: number;
}

export interface UsageBreakdown extends UsageTotals {
  id: string;
  label: string;
}

/** One model's totals on one local day, so day- and range-scoped views can split by model. */
export interface UsageDailyModelMetric extends UsageBreakdown {
  date: string;
}

export interface UsageProjectBreakdown extends UsageBreakdown {
  path: string | null;
  modelIDs: string[];
}

export interface UsageSessionBreakdown extends UsageBreakdown {
  lastActivity: string;
  project: string | null;
  modelIDs: string[];
}

export type LocalUsageStatus = "available" | "no_data" | "partial" | "unavailable";

export interface LocalUsageAnalytics {
  status: LocalUsageStatus;
  source: "local_sessions" | "remote_usage";
  historyDays: number;
  coverageStart: string;
  coverageEnd: string;
  updatedAt: string;
  filesScanned: number;
  recordsProcessed: number;
  totals: UsageTotals;
  today: UsageTotals;
  daily: UsageDailyMetric[];
  hourly?: UsageHourlyMetric[];
  models: UsageBreakdown[];
  /** The same model totals split by day; `models` is their sum over the whole coverage. */
  dailyModels: UsageDailyModelMetric[];
  projects: UsageProjectBreakdown[];
  sessions: UsageSessionBreakdown[];
  serviceTiers: UsageBreakdown[];
  error: ProviderFailure | null;
}

export interface DashboardProvider {
  id: string;
  name: string;
  enabled: boolean;
  source: string;
  windows: DashboardWindow[];
  identity?: { plan?: string | null } | null;
  credits?: { remaining: number; unit: string } | null;
  analytics: LocalUsageAnalytics | null;
  error?: ProviderFailure | null;
  updatedAt?: string | null;
}

export interface DashboardSnapshot {
  schemaVersion: typeof DASHBOARD_SCHEMA_VERSION;
  generatedAt: string;
  staleAfterSeconds: number;
  host: Record<string, JsonValue>;
  providers: DashboardProvider[];
}

/** Default login key when a provider has no stable account id (device-local logs). */
export const HISTORY_LOCAL_ACCOUNT_KEY = "local" as const;

export const HISTORY_DAY_PAYLOAD_VERSION = 1 as const;

/** One provider-login's usage and capacity for one local calendar day. Sync unit. */
export interface HistoryDayPayload {
  payloadVersion: typeof HISTORY_DAY_PAYLOAD_VERSION;
  accountKey: string;
  windows: DashboardWindow[];
  identity: { plan?: string | null } | null;
  credits: { remaining: number; unit: string } | null;
  source: string;
  capturedAt: string;
  status: LocalUsageStatus;
  analyticsSource: LocalUsageAnalytics["source"];
  totals: UsageTotals;
  hourly: UsageHourlyMetric[];
  models: UsageBreakdown[];
  projects: UsageProjectBreakdown[];
  sessions: UsageSessionBreakdown[];
  serviceTiers: UsageBreakdown[];
  filesScanned: number;
  recordsProcessed: number;
  error: ProviderFailure | null;
}

export interface HistoryDayRecord {
  id: string;
  providerId: string;
  accountKey: string;
  localDay: string;
  sealed: boolean;
  changeSeq: number;
  updatedAt: string;
  payload: HistoryDayPayload;
}
