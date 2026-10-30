import type { ProviderAdapter } from "../provider";
import { JsonFileUsageScanner, type JsonFileProvider } from "../analytics/json-file-usage";
import type { SessionSourceOptions } from "../analytics/session-source";

const names: Record<JsonFileProvider, string> = {
  gemini: "Gemini CLI",
  qwen: "Qwen Code",
  cline: "Cline",
  roo: "Roo Code"
};

/**
 * Adapters for tools that record token usage in their own local transcripts.
 * They expose no quota API, so the dashboard gets local history only.
 */
export function createJsonFileAdapter(id: JsonFileProvider, options: SessionSourceOptions = {}): ProviderAdapter {
  const scanner = new JsonFileUsageScanner(id, options);
  return {
    id,
    name: names[id],
    isAvailable: () => scanner.isAvailable(),
    async refresh(context) {
      const analytics = await scanner.scan({
        ...context,
        historyDays: context.historyDaysForAccount("local"),
        timeZone: context.reportingTimeZoneForAccount?.("local")
      });
      return {
        accountKey: "local",
        source: "local_sessions",
        analytics,
        windows: [],
        identity: null,
        credits: null,
        error: analytics.status === "unavailable" ? analytics.error : null,
        updatedAt: context.now.toISOString()
      };
    }
  };
}
