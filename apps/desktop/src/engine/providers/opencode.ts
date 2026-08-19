import type { DashboardProvider } from "@usageatlas/contracts";
import type { ProviderAdapter, ProviderContext } from "../provider";
import {
  OpenCodeUsageScanner,
  type OpenCodeUsageScannerOptions
} from "../analytics/opencode-usage";

interface OpenCodeAdapterOptions extends OpenCodeUsageScannerOptions {
  usageScanner?: OpenCodeUsageScanner;
}

export function createOpenCodeAdapter(options: OpenCodeAdapterOptions = {}): ProviderAdapter {
  const usageScanner = options.usageScanner ?? new OpenCodeUsageScanner(options);
  return {
    id: "opencode",
    name: "OpenCode",
    isAvailable: () => usageScanner.isAvailable(),
    refresh: (context) => refreshOpenCode(context, usageScanner)
  };
}

async function refreshOpenCode(
  context: ProviderContext,
  usageScanner: OpenCodeUsageScanner
): Promise<Omit<DashboardProvider, "id" | "name" | "enabled"> & { accountKey?: string }> {
  const historyDays = context.historyDaysForAccount("local");
  const snapshot = await usageScanner.scan({
    signal: context.signal,
    now: context.now,
    historyDays
  });
  return {
    source: snapshot.hasGoPlan ? "opencode_local_estimate" : "local_sessions",
    windows: snapshot.windows,
    identity: snapshot.hasGoPlan ? { plan: "OpenCode Go" } : null,
    credits: null,
    analytics: snapshot.analytics,
    error: null,
    updatedAt: context.now.toISOString(),
    accountKey: "local"
  };
}
