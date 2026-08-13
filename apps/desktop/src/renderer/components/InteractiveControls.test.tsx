import type { DashboardSnapshot, UsageTotals } from "@usageatlas/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import { InsightsDashboard } from "./InsightsDashboard";

describe("desktop interactive controls", () => {
  it("gives each navigation landmark a unique accessible name", () => {
    const html = renderToStaticMarkup(
      <AppShell engineStatus="ready" onNavigate={vi.fn()} route="day">
        <p>Dashboard</p>
      </AppShell>,
    );

    expect(html).toContain('<nav aria-label="Main navigation"');
    expect(html).toContain('<nav aria-label="App controls"');
  });

  it("uses the real buttons as tooltip triggers without nested controls", () => {
    const html = renderToStaticMarkup(
      <InsightsDashboard
        notice={null}
        onProviderScopeChange={vi.fn()}
        onRefresh={vi.fn()}
        providerScope="all"
        refreshing={false}
        snapshot={snapshot}
      />,
    );

    expect(html).not.toContain('data-slot="tooltip-trigger"');
    expect(html).not.toMatch(/role="button"[^>]*>\s*<button/u);
    expect(html).toContain('aria-label="Refresh insights"');
    expect(html).toContain('id="heatmap-cell-0"');
  });

  it("shows the reason alongside a labelled dismiss control on the page notice", () => {
    const html = renderToStaticMarkup(
      <InsightsDashboard
        notice={{
          detail: "1 log entry could not be parsed.",
          message: "Codex usage history is partial.",
          onDismiss: vi.fn(),
          tone: "stale",
        }}
        onProviderScopeChange={vi.fn()}
        onRefresh={vi.fn()}
        providerScope="all"
        refreshing={false}
        snapshot={snapshot}
      />,
    );

    expect(html).toContain("Codex usage history is partial.");
    expect(html).toContain("1 log entry could not be parsed.");
    expect(html).toContain('aria-label="Dismiss this notice"');
  });
});

const totals: UsageTotals = {
  cacheCreationInputTokens: 0,
  cachedInputTokens: 0,
  estimatedCostUSD: null,
  inputTokens: 10,
  outputTokens: 0,
  requests: 1,
  totalTokens: 10,
  unpricedTokens: 0,
};

const snapshot: DashboardSnapshot = {
  generatedAt: "2026-08-09T00:00:00.000Z",
  host: {},
  providers: [{
    analytics: {
      coverageEnd: "2026-08-04",
      coverageStart: "2026-08-04",
      daily: [{ date: "2026-08-04", ...totals }],
      error: null,
      filesScanned: 1,
      historyDays: 1,
      hourly: [{ date: "2026-08-04", hour: 0, ...totals }],
      models: [],
      projects: [],
      recordsProcessed: 1,
      serviceTiers: [],
      sessions: [],
      source: "local_sessions",
      status: "available",
      today: totals,
      totals,
      updatedAt: "2026-08-09T00:00:00.000Z",
    },
    enabled: true,
    id: "codex",
    name: "Codex",
    source: "fixture",
    windows: [],
  }],
  schemaVersion: 2,
  staleAfterSeconds: 300,
};
