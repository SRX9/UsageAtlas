import type { DashboardProvider, LocalUsageAnalytics, UsageTotals } from "@usageatlas/contracts";
import { describe, expect, it } from "vitest";
import { providerConnection, reconnectSentence } from "./provider-connection";

describe("providerConnection", () => {
  it("asks for the tool's own CLI sign-in when the stored credential is rejected", () => {
    const connection = providerConnection(provider("claude", {
      error: { code: "auth_required", message: "Claude rejected the local OAuth credential.", retryable: false }
    }));

    expect(connection.state).toBe("sign_in_required");
    expect(connection.label).toBe("Sign-in needed");
    expect(connection.command).toBe("claude auth login");
    expect(connection.needsAttention).toBe(true);
  });

  it("flags a signed-out tool even when its local history still scanned cleanly", () => {
    const connection = providerConnection(provider("codex", {
      analytics: analytics(),
      error: { code: "auth_required", message: "Codex is signed out.", retryable: false }
    }));

    expect(connection.state).toBe("sign_in_required");
    expect(reconnectSentence(connection)).toBe("Run this in a terminal, then reload: codex login");
  });

  it("treats a credential failure in the history scan as a sign-in, not a coverage problem", () => {
    const connection = providerConnection(provider("cursor", {
      analytics: analytics({
        error: { code: "auth_required", message: "Cursor usage history requires a current sign-in.", retryable: false },
        status: "unavailable"
      })
    }));

    expect(connection.state).toBe("sign_in_required");
    expect(connection.command).toBeNull();
    expect(connection.action).toBe("Sign in to the Cursor desktop app, then reload.");
  });

  it("leaves a partial history to the coverage list rather than the sign-in", () => {
    const connection = providerConnection(provider("codex", {
      analytics: analytics({
        error: { code: "analytics_partial", message: "1 log entry could not be parsed.", retryable: true },
        status: "partial"
      })
    }));

    expect(connection.state).toBe("connected");
    expect(connection.needsAttention).toBe(false);
  });

  it("separates a tool that was never set up from one that signed out", () => {
    const connection = providerConnection(provider("codex", {
      error: { code: "credentials_missing", message: "Codex CLI is not installed.", retryable: false }
    }));

    expect(connection.state).toBe("not_connected");
    expect(connection.label).toBe("Not connected");
    expect(connection.action).toBe("Install Codex, sign in, then reload:");
  });

  it("offers a retry, not a sign-in, when the last check simply failed", () => {
    const connection = providerConnection(provider("claude", {
      error: { code: "network_error", message: "Claude usage request failed.", retryable: true }
    }));

    expect(connection.state).toBe("not_reporting");
    expect(connection.command).toBeNull();
    expect(connection.action).toBe("Reload to try again.");
  });

  it("says nothing to act on while a tool is connected or switched off", () => {
    expect(providerConnection(provider("claude", { identity: { plan: "max" } })))
      .toMatchObject({ state: "connected", summary: "Signed in · max", needsAttention: false });
    expect(providerConnection(provider("claude", { enabled: false })))
      .toMatchObject({ state: "disabled", action: null, needsAttention: false });
  });
});

function provider(id: string, overrides: Partial<DashboardProvider> = {}): DashboardProvider {
  return {
    id,
    name: id === "claude" ? "Claude" : id === "codex" ? "Codex" : "Cursor",
    enabled: true,
    source: "oauth",
    windows: [],
    identity: null,
    credits: null,
    analytics: null,
    error: null,
    updatedAt: "2026-08-15T00:00:00.000Z",
    ...overrides
  };
}

function analytics(overrides: Partial<LocalUsageAnalytics> = {}): LocalUsageAnalytics {
  return {
    status: "available",
    source: "local_sessions",
    historyDays: 90,
    coverageStart: "2026-06-19",
    coverageEnd: "2026-08-15",
    updatedAt: "2026-08-15T00:00:00.000Z",
    filesScanned: 85,
    recordsProcessed: 900,
    totals: totals(),
    today: totals(),
    daily: [],
    models: [],
    dailyModels: [],
    projects: [],
    sessions: [],
    serviceTiers: [],
    error: null,
    ...overrides
  };
}

function totals(): UsageTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requests: 0,
    estimatedCostUSD: null,
    unpricedTokens: 0
  };
}
