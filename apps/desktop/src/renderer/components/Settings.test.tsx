import type { DashboardProvider } from "@usageatlas/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DesktopPreferences } from "../../shared/desktop-api";
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

function render(providers: DashboardProvider[]): string {
  return renderToStaticMarkup(
    <Settings
      backgroundError={null}
      customBackgroundUrl={null}
      onChooseCustomBackground={vi.fn()}
      onOpenExternal={vi.fn()}
      onRefresh={vi.fn()}
      onSetProviderEnabled={vi.fn()}
      onUpdate={vi.fn()}
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
    backgroundImage: "default",
    customBackgroundName: null,
    launchAtLogin: false,
    minimizeToTray: true,
    anonymousAnalytics: true,
    providerEnabled: {},
    limitOrder: [],
    trayLimits: {},
    usageAlerts: {}
  };
}
