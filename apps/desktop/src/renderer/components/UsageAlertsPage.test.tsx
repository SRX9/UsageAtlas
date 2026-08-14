import type { DashboardProvider } from "@usageatlas/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DesktopPreferences } from "../../shared/desktop-api";
import { UsageAlertsPage } from "./UsageAlertsPage";

describe("UsageAlertsPage", () => {
  it("renders each usage alert as an interactive switch", () => {
    const html = renderToStaticMarkup(
      <UsageAlertsPage
        preferences={preferences}
        providers={[provider]}
        saving={false}
        onUpdate={vi.fn()}
      />,
    );

    expect(html).toContain('data-slot="switch-content"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-label="Claude 5-hour usage alert"');
  });
});

const preferences: DesktopPreferences = {
  anonymousAnalytics: true,
  backgroundImage: "default",
  customBackgroundName: null,
  launchAtLogin: false,
  limitOrder: [],
  minimizeToTray: true,
  providerEnabled: {},
  trayLimits: {},
  usageAlerts: {},
};

const provider: DashboardProvider = {
  analytics: null,
  enabled: true,
  id: "claude",
  name: "Claude",
  source: "fixture",
  windows: [{
    kind: "session",
    label: "5-hour",
    remainingPercent: 75,
    usedPercent: 25,
  }],
};
