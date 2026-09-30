import type { ProviderAdapter } from "../provider";
import { AntigravityUsageScanner } from "../analytics/antigravity-usage";
import { JsonSessionUsageScanner } from "../analytics/pi-muse-usage";
import type { SessionSourceOptions } from "../analytics/session-source";

/** Local history never establishes the identity of a provider login or its remaining quota. */
export function createLocalToolAdapter(id: "antigravity" | "pi" | "muse", options: SessionSourceOptions = {}): ProviderAdapter {
  const name = { antigravity: "Antigravity", pi: "Pi / OMP", muse: "Muse Code" }[id];
  const scanner = id === "antigravity" ? new AntigravityUsageScanner(options) : new JsonSessionUsageScanner(id, options);
  return {
    id, name, isAvailable: () => scanner.isAvailable(),
    async refresh(context) {
      const analytics = await scanner.scan({ ...context, historyDays: context.historyDaysForAccount("local"),
        timeZone: context.reportingTimeZoneForAccount?.("local") });
      return { accountKey: "local", source: "local_sessions", analytics, windows: [], identity: null, credits: null,
        error: analytics.status === "unavailable" ? analytics.error : null, updatedAt: context.now.toISOString() };
    }
  };
}
