import fixtureSnapshot from "@usageatlas/contracts/fixtures/dashboard-v2.json";
import type { DashboardSnapshot } from "@usageatlas/contracts";
import { describe, expect, it } from "vitest";
import { trayLimitLabels } from "./tray-limits";

describe("trayLimitLabels", () => {
  it("lists every ranked limit, not one row per tool", () => {
    expect(trayLimitLabels(fixtureSnapshot as DashboardSnapshot, ["claude:weekly", "codex:session"])).toEqual([
      "Claude - Weekly: 46% available",
      "Codex - 5-hour: 75% available",
      "Claude - 5-hour: 32% available",
      "Codex - Weekly: 60% available"
    ]);
  });

  it("leaves out the limits switched off for the tray", () => {
    expect(trayLimitLabels(
      fixtureSnapshot as DashboardSnapshot,
      ["claude:weekly"],
      { "codex:session": false, "codex:weekly": false, "claude:session": false }
    )).toEqual(["Claude - Weekly: 46% available"]);
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
