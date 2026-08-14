import fixtureSnapshot from "@usageatlas/contracts/fixtures/dashboard-v2.json";
import type { DashboardSnapshot } from "@usageatlas/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LimitsDashboard } from "./LimitsDashboard";

describe("LimitsDashboard", () => {
  it("ranks each limit on its own row instead of grouping them by tool", () => {
    const html = render();

    expect(html).toContain("Codex 5-hour");
    expect(html).toContain("Codex Weekly");
    expect(html).toContain("Claude 5-hour");
    expect(html).toContain("Claude Weekly");
    expect(html).toContain('aria-label="Move Claude Weekly earlier"');
  });

  it("gives every limit its own tray switch", () => {
    const html = render();

    expect(html).toContain('aria-label="Show Claude Weekly in the tray menu"');
    expect(html).toContain('role="switch"');
  });

  it("puts the saved ranking first, across tools", () => {
    const html = render(["claude:weekly", "cursor:api"]);

    expect(html.indexOf("Claude Weekly")).toBeLessThan(html.indexOf("Codex 5-hour"));
  });
});

function render(limitOrder: string[] = []): string {
  return renderToStaticMarkup(
    <LimitsDashboard
      limitOrder={limitOrder}
      onBack={vi.fn()}
      onLimitOrderChange={vi.fn()}
      onRefresh={vi.fn()}
      onTrayLimitsChange={vi.fn()}
      refreshing={false}
      snapshot={fixtureSnapshot as DashboardSnapshot}
      trayLimits={{ "codex:weekly": false }}
    />
  );
}
