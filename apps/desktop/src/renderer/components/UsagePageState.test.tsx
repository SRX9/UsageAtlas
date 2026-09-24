import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { refreshStatusLabel, UsageLoading, UsageRefreshStatus, UsageStorageStatus } from "./UsagePageState";

describe("usage loading", () => {
  it("shows committed local records and stops the progress indicator on failure", () => {
    const html = renderToStaticMarkup(<UsageStorageStatus progress={{ completed: 250, total: 701, error: null }} />);
    expect(html).toContain("Saving local history");
    expect(html).toContain("250 of 701 records");
    const failed = renderToStaticMarkup(<UsageStorageStatus progress={{ completed: 250, total: 701, error: "Refresh usage to retry." }} />);
    expect(failed).toContain("Refresh usage to retry.");
    expect(failed).not.toContain("progress-circle");
  });

  it("names the tool currently being updated", () => {
    expect(refreshStatusLabel({
      completed: 0,
      total: 2,
      providerID: "cursor",
      providerName: "Cursor",
      status: "started"
    }, "ready")).toContain("Cursor");
  });

  it("keeps the count out of the status sentence", () => {
    expect(refreshStatusLabel({
      completed: 3,
      total: 4,
      providerID: "claude",
      providerName: "Claude",
      status: "completed"
    }, "ready")).toBe("Updating usage");
  });

  it("renders a ring with a progress label instead of silent placeholders", () => {
    const html = renderToStaticMarkup(
      <UsageLoading
        engineStatus="ready"
        progress={{
          completed: 1,
          total: 3,
          providerID: "claude",
          providerName: "Claude",
          status: "started"
        }}
      />
    );
    expect(html).toContain("Loading your usage");
    expect(html).toContain("Claude");
    expect(html).toContain("progress-circle");
    expect(html).toContain("1");
    expect(html).toContain("/3");
    expect(html).not.toContain("skeleton");
    expect(html).not.toContain("progress-bar");
  });

  it("renders a compact ring while today’s usage refreshes", () => {
    const html = renderToStaticMarkup(
      <UsageRefreshStatus
        engineStatus="ready"
        progress={{
          completed: 2,
          total: 4,
          providerID: "codex",
          providerName: "Codex",
          status: "started"
        }}
      />
    );
    expect(html).toContain("progress-circle");
    expect(html).toContain("Codex");
    expect(html).not.toContain("progress-bar");
  });
});
