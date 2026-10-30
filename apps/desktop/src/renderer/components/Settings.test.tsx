import type { DashboardProvider } from "@usageatlas/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ADVANCED_PREFERENCES,
  DEFAULT_WIDGET_PREFERENCES,
  type DesktopPreferences
} from "../../shared/desktop-api";
import { Settings } from "./Settings";

describe("Settings sources", () => {
  it("flags a signed-out source with the command that reconnects it", () => {
    const html = render([provider({
      error: { code: "auth_required", message: "Codex is signed out.", retryable: false }
    })]);

    expect(html).toContain("Sign-in needed");
    expect(html).toContain("Signed out on this computer.");
    expect(html).toContain("codex login");
    expect(html).toContain("Check sources again");
  });

  it("leaves a connected source unflagged and offers no recheck", () => {
    const html = render([provider({ identity: { plan: "pro" } })]);

    expect(html).toContain("Signed in · pro");
    expect(html).not.toContain("atlas-source-pill");
    expect(html).not.toContain("Check sources again");
  });

  it("explains a source the user switched off instead of nagging about its sign-in", () => {
    const html = render([provider({
      enabled: false,
      error: { code: "auth_required", message: "Codex is signed out.", retryable: false }
    })]);

    expect(html).toContain("Turned off. Enable it to include this tool.");
    expect(html).not.toContain("Sign-in needed");
  });
});

describe("Settings updates", () => {
  it("offers both publishers to update from and names the selected one", () => {
    const html = render([]);

    expect(html).toContain("Updates from");
    expect(html).toContain("Unofficial fork");
    expect(html).toContain("Official app");
    expect(html).toContain("github.com/Artleboss2/UsageAtlas-Unofficial");
  });
});

describe("Settings appearance", () => {
  it("offers the bundled fonts and application marks", () => {
    const html = render([]);

    expect(html).toContain("Manrope");
    expect(html).toContain("Figtree");
    expect(html).toContain("Geist");
    expect(html).toContain("Datamosh");
    expect(html).toContain("Classic");
    expect(html).toContain("Duotone");
    expect(html).toContain("Interface text size");
    expect(html).toContain("Text colour");
  });

  it("offers full figures, an accent tint, solid surfaces and a motion switch", () => {
    const html = render([]);

    expect(html).toContain("Every digit");
    expect(html).toContain("Short units");
    expect(html).toContain("Accent colour");
    expect(html).toContain("Glass");
    expect(html).toContain("Solid");
    expect(html).toContain("Animate the interface");
  });

  it("offers Mist, Valley, Night, Monterey, and Big Sur as background choices", () => {
    const html = render([]);

    expect(html).toContain("Mist");
    expect(html).toContain("Valley");
    expect(html).toContain("Night");
    expect(html).toContain("Monterey");
    expect(html).toContain("Big Sur");
    expect(html).toContain('value="valley"');
    expect(html).toContain('value="mist"');
    expect(html).toContain('value="anime-calm"');
    expect(html).toContain('value="monterey"');
    expect(html).toContain('value="big-sur"');
  });
});

function render(providers: DashboardProvider[]): string {
  return renderToStaticMarkup(
    <Settings
      updateState={null}
      onCheckForUpdates={vi.fn()}
      onInstallUpdate={vi.fn()}
      backgroundError={null}
      customBackgroundUrl={null}
      onChooseCustomBackground={vi.fn()}
      onOpenExternal={vi.fn()}
      onRefresh={vi.fn()}
      onSetProviderEnabled={vi.fn()}
      onUpdate={vi.fn()}
      onShowWidget={vi.fn()}
      onHideWidget={vi.fn()}
      onExportSettings={vi.fn()}
      onImportSettings={vi.fn()}
      onChooseFolder={vi.fn()}
      onChooseExportDirectory={vi.fn()}
      onExportUsage={vi.fn()}
      onRestartApp={vi.fn()}
      preferences={preferences()}
      providerSaving={null}
      providers={providers}
      refreshing={false}
      saving={false}
    />
  );
}

function provider(overrides: Partial<DashboardProvider> = {}): DashboardProvider {
  return {
    id: "codex",
    name: "Codex",
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

function preferences(): DesktopPreferences {
  return {
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
    backgroundImage: "mist",
    customBackgroundName: null,
    launchAtLogin: false,
    minimizeToTray: true,
    anonymousAnalytics: true,
    providerEnabled: {},
    limitOrder: [],
    trayLimits: {},
    usageAlerts: {},
    reportPlans: [],
    startMinimized: false,
    hotkey: "CommandOrControl+Shift+U",
    pricingSyncHours: 24,
    powerSaving: true,
    widget: { ...DEFAULT_WIDGET_PREFERENCES },
    advanced: { ...DEFAULT_ADVANCED_PREFERENCES }
  };
}
