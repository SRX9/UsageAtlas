import type { DashboardProvider } from "@usageatlas/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HealthNotice } from "./Diagnostics";
import { Diagnostics } from "./Diagnostics";

describe("Diagnostics", () => {
  it("carries the notices the usage pages no longer interrupt with", () => {
    const html = render([
      {
        detail: "1 log entry could not be parsed.",
        message: "Codex usage history is partial.",
        tone: "warning"
      }
    ]);

    expect(html).toContain("Codex usage history is partial.");
    expect(html).toContain("1 log entry could not be parsed.");
    expect(html).toContain('aria-label="Dismiss this notice"');
  });

  it("shows no notice list when nothing qualifies the numbers", () => {
    expect(render([])).not.toContain("atlas-health-notices");
  });

  it("names the sign-in a source needs beside the history it still reported", () => {
    const html = render([], [provider({
      error: { code: "auth_required", message: "Claude rejected the local OAuth credential.", retryable: false }
    })]);

    expect(html).toContain("Sign-in needed");
    expect(html).toContain("Signed out on this computer.");
    expect(html).toContain("claude auth login");
  });

  it("marks a working source as connected", () => {
    const html = render([], [provider()]);

    expect(html).toContain("Connected");
    expect(html).not.toContain("Sign-in needed");
  });
});

function render(notices: HealthNotice[], providers: DashboardProvider[] = []): string {
  return renderToStaticMarkup(
    <Diagnostics
      diagnostics={{ messages: [], restartCount: 0, status: "ready" }}
      loading={false}
      notices={notices}
      onDismissNotice={vi.fn()}
      onOpenExternal={vi.fn()}
      onReload={vi.fn()}
      providers={providers}
    />
  );
}

function provider(overrides: Partial<DashboardProvider> = {}): DashboardProvider {
  return {
    id: "claude",
    name: "Claude",
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
