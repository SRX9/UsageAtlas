import type { LocalUsageAnalytics, ProviderFailure } from "@usageatlas/contracts";
import { ProviderError } from "../provider";
import type { AnalyticsProvider, AnalyticsScanner, AnalyticsScanContext } from "./local-usage";
import { unavailableAnalytics } from "./local-usage";

export async function scanProviderAnalytics(
  scanner: AnalyticsScanner,
  provider: AnalyticsProvider,
  context: AnalyticsScanContext
): Promise<LocalUsageAnalytics> {
  try {
    return await scanner.scan(provider, context);
  } catch {
    if (context.signal.aborted) throw new DOMException("Analytics scan timed out.", "AbortError");
    return unavailableAnalytics(context.now, 90, {
      code: "analytics_unavailable",
      message: "Local session analytics could not be refreshed.",
      retryable: true
    });
  }
}

export function providerFailure(error: unknown, fallbackMessage: string): ProviderFailure {
  if (error instanceof ProviderError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: "refresh_failed",
    message: error instanceof Error ? error.message : fallbackMessage,
    retryable: true
  };
}
