import fixtureSnapshot from "@usageatlas/contracts/fixtures/dashboard-v2.json";
import type { DashboardSnapshot } from "@usageatlas/contracts";
import { describe, expect, it } from "vitest";
import { trayLimitLabels } from "./tray-limits";

describe("trayLimitLabels", () => {
  it("formats the same four ranked limits used by the dashboard preview", () => {
    expect(trayLimitLabels(fixtureSnapshot as DashboardSnapshot, ["claude", "codex"])).toEqual([
      "Claude - 5-hour: 32% available",
      "Codex - Weekly: 60% available"
    ]);
  });

  it("returns no rows when providers do not report live limits", () => {
    const snapshot = {
      ...(fixtureSnapshot as DashboardSnapshot),
      providers: (fixtureSnapshot as DashboardSnapshot).providers.map((provider) => ({
        ...provider,
        windows: []
      }))
    };

    expect(trayLimitLabels(snapshot, [])).toEqual([]);
  });
});
