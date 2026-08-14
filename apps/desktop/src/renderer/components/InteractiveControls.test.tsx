import type { DashboardSnapshot, UsageTotals } from "@usageatlas/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import { InsightsDashboard } from "./InsightsDashboard";

describe("desktop interactive controls", () => {
  it("gives each navigation landmark a unique accessible name", () => {
    const html = renderToStaticMarkup(
      <AppShell engineStatus="ready" noticeCount={0} onNavigate={vi.fn()} route="day">
        <p>Dashboard</p>
      </AppShell>,
    );

    expect(html).toContain('<nav aria-label="Main navigation"');
    expect(html).toContain('<nav aria-label="App controls"');
  });

  it("counts open health notices on the diagnostics rail button", () => {
    const html = renderToStaticMarkup(
      <AppShell engineStatus="ready" noticeCount={2} onNavigate={vi.fn()} route="day">
        <p>Dashboard</p>
      </AppShell>,
    );

    expect(html).toContain('aria-label="Diagnostics: Ready · 2 notices"');
    expect(html).toContain('data-notices="true"');
  });

  it("uses the real buttons as tooltip triggers without nested controls", () => {
    const html = renderToStaticMarkup(
      <InsightsDashboard
        onProviderScopeChange={vi.fn()}
        onRefresh={vi.fn()}
        providerScope="all"
        refreshing={false}
        snapshot={snapshot}
      />,
    );

    expect(html).not.toMatch(/role="button"[^>]*>\s*<button/u);
    expect(html).toContain('aria-label="Refresh insights"');
    expect(html).toContain('id="heatmap-cell-0"');
  });

  it("makes each heatmap cell its own tooltip trigger so hover opens the detail", () => {
    const html = renderToStaticMarkup(
      <InsightsDashboard
        onProviderScopeChange={vi.fn()}
        onRefresh={vi.fn()}
        providerScope="all"
        refreshing={false}
        snapshot={snapshot}
      />,
    );

    expect(html).toMatch(/<button[^>]*data-slot="tooltip-trigger"[^>]*id="heatmap-cell-0"/u);
    expect(html).not.toMatch(/<button[^>]*role="button"/u);
  });

  it("keeps usage pages free of the notice banner", () => {
    const html = renderToStaticMarkup(
      <InsightsDashboard
        onProviderScopeChange={vi.fn()}
        onRefresh={vi.fn()}
        providerScope="all"
        refreshing={false}
        snapshot={snapshot}
      />,
    );

    expect(html).not.toContain("atlas-health-notices");
    expect(html).not.toContain('data-slot="alert"');
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
      dailyModels: [],
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
