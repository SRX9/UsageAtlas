import type { DashboardProvider } from "@usageatlas/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ADVANCED_PREFERENCES,
  DEFAULT_WIDGET_PREFERENCES,
  type DesktopPreferences
} from "../../shared/desktop-api";
import type { ReportPlan } from "../../shared/report-plans";
import { Attribution } from "./Attribution";

describe("Attribution rules", () => {
  it("shows a source relabelled under an official provider", () => {
    const html = render(
      [provider({ id: "freebuff", name: "Freebuff" }), provider()],
      [{ source: "freebuff", targets: [{ reportAs: "codex", model: "gpt-5.3-codex", weight: 100 }] }]
    );

    expect(html).toContain("Freebuff");
    expect(html).toContain('value="freebuff"');
    expect(html).toContain('value="codex"');
    expect(html).toContain('value="gpt-5.3-codex"');
    expect(html).toContain("Save rules");
    expect(html).toContain('aria-label="Remove the rule for freebuff"');
  });

  it("says nothing is relabelled until a rule exists", () => {
    const html = render([provider({ id: "freebuff", name: "Freebuff" })]);

    expect(html).toContain("No rule yet. Official sources save under their own name; a private source stays on this computer until you add a mix here.");
    expect(html).toContain("Add rule");
    expect(html).not.toContain('value="gpt-5.3-codex"');
  });

  it("offers no more rules once every source has one", () => {
    const html = render(
      [provider({ id: "freebuff", name: "Freebuff" }), provider({ id: "zai", name: "z.ai" })],
      [
        { source: "freebuff", targets: [{ reportAs: "codex", model: "gpt-5.3-codex", weight: 100 }] },
        { source: "zai", targets: [{ reportAs: "claude", model: "claude-sonnet-4-5", weight: 100 }] }
      ]
    );

    expect(html).toContain('aria-label="Remove the rule for freebuff"');
    expect(html).toContain('aria-label="Remove the rule for zai"');
    expect(html).toContain('disabled=""');
  });

  it("spreads one source over several targets and shows the shares it will draw", () => {
    const html = render(
      [provider({ id: "freebuff", name: "Freebuff" })],
      [{
        source: "freebuff",
        targets: [
          { reportAs: "codex", model: "gpt-5.3-codex", weight: 30 },
          { reportAs: "claude", model: "claude-sonnet-4-6", weight: 20 },
          { reportAs: "cursor", model: "composer-2.5", weight: 50 }
        ]
      }]
    );

    expect(html).toContain('value="30"');
    expect(html).toContain('value="20"');
    expect(html).toContain('value="50"');
    expect(html).toContain("30% of freebuff");
    expect(html).toContain("20% of freebuff");
    expect(html).toContain("50% of freebuff");
    expect(html).toContain('aria-label="Share of tokens"');
    expect(html).toContain("Add target");
  });

  it("weights shares relative to the plan instead of requiring a hundred percent", () => {
    const html = render(
      [provider({ id: "freebuff", name: "Freebuff" })],
      [{
        source: "freebuff",
        targets: [
          { reportAs: "codex", model: "gpt-5.3-codex", weight: 30 },
          { reportAs: "claude", model: "claude-sonnet-4-6", weight: 20 },
          { reportAs: "cursor", model: "composer-2.5", weight: 50 }
        ]
      }]
    );

    expect(html).toContain("100% of this source&#x27;s tokens, spread over 3 targets.");
    expect(html).toContain("The wheel weighs tokens");
  });

  it("offers the models the reported provider runs instead of a blank field", () => {
    const html = render(
      [provider({ id: "freebuff", name: "Freebuff" }), provider()],
      [{ source: "freebuff", targets: [{ reportAs: "codex", model: "gpt-5.3-codex", weight: 100 }] }]
    );

    expect(html).toContain('aria-label="Reported model"');
    for (const model of ["gpt-5.6-sol", "gpt-5.5", "gpt-5.3-codex", "codex-auto-review"]) {
      expect(html).toContain(`value="${model}"`);
    }
    // Another provider's catalog is not offered under Codex.
    expect(html).not.toContain('value="claude-opus-5"');
    expect(html).not.toContain("placeholder=\"gpt-5.3-codex\"");
  });

  it("offers the reported provider's catalog for the model each target names", () => {
    const html = render(
      [provider({ id: "freebuff", name: "Freebuff" }), provider({ id: "zai", name: "z.ai" })],
      [{ source: "zai", targets: [{ reportAs: "claude", model: "claude-sonnet-4-5", weight: 100 }] }]
    );

    expect(html).toContain('value="claude-opus-5"');
    expect(html).toContain('value="claude-haiku-4-5"');
    expect(html).not.toContain('value="gpt-5.3-codex"');
  });

  it("keeps a model saved before the catalog existed selectable", () => {
    const html = render(
      [provider({ id: "freebuff", name: "Freebuff" }), provider()],
      [{ source: "freebuff", targets: [{ reportAs: "codex", model: "gpt-private-2026", weight: 100 }] }]
    );

    expect(html).toContain('value="gpt-private-2026"');
  });

  it("explains the round trip the wheel makes", () => {
    const html = render([]);

    expect(html).toContain("this computer keeps counting Freebuff tokens");
    expect(html).toContain("Allocation follows the token deficit, not the request count");
  });

  it("restates the saved selection above the editors", () => {
    const html = render(
      [provider({ id: "freebuff", name: "Freebuff" })],
      [{
        source: "freebuff",
        targets: [
          { reportAs: "codex", model: "gpt-5.3-codex", weight: 30 },
          { reportAs: "claude", model: "claude-sonnet-4-6", weight: 70 }
        ]
      }]
    );

    expect(html).toContain("Currently reporting");
    expect(html).toContain("codex · gpt-5.3-codex");
    expect(html).toContain("30%");
    expect(html).toContain("70%");
  });
});

function render(providers: DashboardProvider[], reportPlans: ReportPlan[] = []): string {
  return renderToStaticMarkup(
    <Attribution
      onSave={vi.fn()}
      preferences={preferences(reportPlans)}
      providers={providers}
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

function preferences(reportPlans: ReportPlan[]): DesktopPreferences {
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
    reportPlans,
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
    startMinimized: false,
    hotkey: "CommandOrControl+Shift+U",
    pricingSyncHours: 24,
    powerSaving: true,
    widget: { ...DEFAULT_WIDGET_PREFERENCES },
    advanced: { ...DEFAULT_ADVANCED_PREFERENCES }
  };
}
