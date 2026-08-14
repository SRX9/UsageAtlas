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
        tone: "stale"
      }
    ]);

    expect(html).toContain("Codex usage history is partial.");
    expect(html).toContain("1 log entry could not be parsed.");
    expect(html).toContain('aria-label="Dismiss this notice"');
  });

  it("shows no notice list when nothing qualifies the numbers", () => {
    expect(render([])).not.toContain("atlas-health-notices");
  });
});

function render(notices: HealthNotice[]): string {
  return renderToStaticMarkup(
    <Diagnostics
      diagnostics={{ messages: [], restartCount: 0, status: "ready" }}
      loading={false}
      notices={notices}
      onDismissNotice={vi.fn()}
      onOpenExternal={vi.fn()}
      onReload={vi.fn()}
      providers={[]}
    />
  );
}
