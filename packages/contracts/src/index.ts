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
