import type { DashboardProvider } from "@usageatlas/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ADVANCED_PREFERENCES,
  DEFAULT_WIDGET_PREFERENCES,
  type DesktopPreferences
} from "../../shared/desktop-api";
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

  it("lists received alerts in the tab, not only as a popup", () => {
    const html = renderToStaticMarkup(
      <UsageAlertsPage
        notifications={[{
          title: "Claude capacity alert",
          body: "Weekly has 20% remaining.",
          route: "limits",
          receivedAt: "2026-10-29T03:00:00.000Z"
        }]}
        onClearNotifications={vi.fn()}
        preferences={preferences}
        providers={[provider]}
        saving={false}
        onUpdate={vi.fn()}
      />,
    );

    expect(html).toContain("Claude capacity alert");
    expect(html).toContain("Weekly has 20% remaining.");
    expect(html).toContain("Clear notifications");
  });

  it("previews the daily token notification in the exact wording it sends", () => {
    const html = renderToStaticMarkup(
      <UsageAlertsPage
        preferences={preferences}
        providers={[provider]}
        saving={false}
        onUpdate={vi.fn()}
      />,
    );

    expect(html).toContain("Daily token alert");
    expect(html).toContain("You used 100,000 tokens on Claude today.");
  });
});

const preferences: DesktopPreferences = {
  appearance: {
    theme: "system",
    font: "system",
    fontScale: 1,
    textColor: null,
    mark: "datamosh",
    numberStyle: "exact",
    accent: "system",
    surface: "glass",
    animate: true,
    density: "comfortable",
    windowOpacity: 1,
    blur: 18,
    providerColors: {}
  },
  tokenAlerts: { enabled: true, thresholdTokens: 100_000 },
  language: "system",
  updateChannel: "fork",
    updateRepository: "",
  anonymousAnalytics: true,
    backgroundImage: "mist",
  customBackgroundName: null,
  launchAtLogin: false,
  limitOrder: [],
  minimizeToTray: true,
  providerEnabled: {},
  trayLimits: {},
  usageAlerts: {},
  reportPlans: [],
  startMinimized: false,
  hotkey: "CommandOrControl+Shift+U",
  pricingSyncHours: 24,
  powerSaving: true,
  widget: { ...DEFAULT_WIDGET_PREFERENCES },
  advanced: { ...DEFAULT_ADVANCED_PREFERENCES },
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
