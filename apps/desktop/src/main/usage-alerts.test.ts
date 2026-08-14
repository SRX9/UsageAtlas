import type { DashboardSnapshot, DashboardWindow } from "@usageatlas/contracts";
import type { UsageAlertPreferences } from "../shared/desktop-api";
import { describe, expect, it } from "vitest";
import {
  createUsageAlertNotification,
  USAGE_ALERT_DELIVERY_COOLDOWN_MS,
  UsageAlertDeliveryLog,
  UsageAlertEvaluator
} from "./usage-alerts";

const enabledRule: UsageAlertPreferences = {
  codex: { session: { enabled: true, thresholdPercent: 40 } }
};

const bothWindowsRule: UsageAlertPreferences = {
  codex: {
    session: { enabled: true, thresholdPercent: 40 },
    weekly: { enabled: true, thresholdPercent: 40 }
  }
};

describe("UsageAlertEvaluator", () => {
  it("waits until remaining capacity falls to the configured threshold", () => {
    const evaluator = new UsageAlertEvaluator();

    expect(evaluator.evaluate(snapshot(60), enabledRule)).toEqual([]);
    expect(evaluator.evaluate(snapshot(58), enabledRule)).toEqual([]);
    expect(evaluator.evaluate(snapshot(40), enabledRule)).toEqual([
      expect.objectContaining({
        providerID: "codex",
        windowKind: "session",
        thresholdPercent: 40,
        remainingPercent: 40
      })
    ]);
    expect(evaluator.evaluate(snapshot(35), enabledRule)).toEqual([]);
    expect(evaluator.evaluate(snapshot(55), enabledRule)).toEqual([]);
    expect(evaluator.evaluate(snapshot(39), enabledRule)).toEqual([]);
  });

  it("re-arms when the provider reports a new reset cycle", () => {
    const evaluator = new UsageAlertEvaluator();

    evaluator.evaluate(snapshot(60, "cycle-1"), enabledRule);
    expect(evaluator.evaluate(snapshot(40, "cycle-1"), enabledRule)).toHaveLength(1);
    expect(evaluator.evaluate(snapshot(35, "cycle-2"), enabledRule)).toHaveLength(1);
  });

  it("does not re-alert when Codex recomputes the same window's reset timestamp", () => {
    const evaluator = new UsageAlertEvaluator();
    const firstReset = "2026-08-14T16:00:00.000Z";
    const driftedReset = "2026-08-14T15:59:40.000Z";
    const laterTick = "2026-08-14T15:56:00.000Z";

    evaluator.evaluate(snapshot(60, firstReset), enabledRule);
    expect(evaluator.evaluate(snapshot(40, firstReset), enabledRule)).toHaveLength(1);
    expect(evaluator.evaluate(snapshot(39, driftedReset), enabledRule)).toEqual([]);
    expect(evaluator.evaluate(snapshot(31, laterTick), enabledRule)).toEqual([]);
    expect(evaluator.evaluate(snapshot(28, "2026-08-14T19:30:00.000Z"), enabledRule)).toEqual([]);
  });

  it("re-arms after a real reset that restores capacity", () => {
    const evaluator = new UsageAlertEvaluator();
    const cycleOneEnd = "2026-08-14T16:00:00.000Z";
    const cycleTwoEnd = "2026-08-14T21:00:00.000Z";

    evaluator.evaluate(snapshot(60, cycleOneEnd), enabledRule);
    expect(evaluator.evaluate(snapshot(18, cycleOneEnd), enabledRule)).toHaveLength(1);
    expect(evaluator.evaluate(snapshot(92, cycleTwoEnd), enabledRule)).toEqual([]);
    expect(evaluator.evaluate(snapshot(39, cycleTwoEnd), enabledRule)).toHaveLength(1);
  });

  it("alerts once when a new window is already below the threshold", () => {
    const evaluator = new UsageAlertEvaluator();
    const cycleOneEnd = "2026-08-14T16:00:00.000Z";
    const cycleTwoEnd = "2026-08-14T21:00:00.000Z";

    evaluator.evaluate(snapshot(12, cycleOneEnd), enabledRule);
    expect(evaluator.evaluate(snapshot(35, cycleTwoEnd), enabledRule)).toHaveLength(1);
    expect(evaluator.evaluate(snapshot(30, cycleTwoEnd), enabledRule)).toEqual([]);
  });

  it("uses a rise above the threshold to re-arm windows without reset metadata", () => {
    const evaluator = new UsageAlertEvaluator();

    evaluator.evaluate(snapshot(60, null), enabledRule);
    expect(evaluator.evaluate(snapshot(40, null), enabledRule)).toHaveLength(1);
    evaluator.evaluate(snapshot(70, null), enabledRule);
    expect(evaluator.evaluate(snapshot(39, null), enabledRule)).toHaveLength(1);
  });

  it("tracks disabled rules so enabling one does not alert until the next crossing", () => {
    const evaluator = new UsageAlertEvaluator();
    const disabledRule: UsageAlertPreferences = {
      codex: { session: { enabled: false, thresholdPercent: 40 } }
    };

    evaluator.evaluate(snapshot(60), disabledRule);
    expect(evaluator.evaluate(snapshot(60), enabledRule)).toEqual([]);
    expect(evaluator.evaluate(snapshot(40), enabledRule)).toHaveLength(1);
  });

  it("supports a lower remaining-capacity threshold in the same reset cycle", () => {
    const evaluator = new UsageAlertEvaluator();
    const lowerRule: UsageAlertPreferences = {
      codex: { session: { enabled: true, thresholdPercent: 20 } }
    };

    evaluator.evaluate(snapshot(60), enabledRule);
    expect(evaluator.evaluate(snapshot(40), enabledRule)).toHaveLength(1);
    expect(evaluator.evaluate(snapshot(30), lowerRule)).toEqual([]);
    expect(evaluator.evaluate(snapshot(20), lowerRule)).toHaveLength(1);
  });

  it("alerts each Codex window once instead of oscillating across session and weekly", () => {
    const evaluator = new UsageAlertEvaluator();
    const sessionReset = "2026-08-14T16:00:00.000Z";
    const weeklyReset = "2026-08-21T00:00:00.000Z";

    expect(evaluator.evaluate(codexSnapshot([
      windowAt("session", "5-hour", 55, sessionReset),
      windowAt("weekly", "Weekly", 62, weeklyReset)
    ]), bothWindowsRule)).toEqual([]);
    expect(evaluator.evaluate(codexSnapshot([
      windowAt("session", "5-hour", 38, "2026-08-14T15:58:00.000Z"),
      windowAt("weekly", "Weekly", 39, "2026-08-20T22:00:00.000Z")
    ]), bothWindowsRule)).toEqual([
      expect.objectContaining({ windowKind: "session", remainingPercent: 38 }),
      expect.objectContaining({ windowKind: "weekly", remainingPercent: 39 })
    ]);
    expect(evaluator.evaluate(codexSnapshot([
      windowAt("session", "5-hour", 31, "2026-08-14T15:50:00.000Z"),
      windowAt("weekly", "Weekly", 33, "2026-08-20T20:00:00.000Z")
    ]), bothWindowsRule)).toEqual([]);
  });

  it("does not re-alert when two windows share a kind and straddle the threshold", () => {
    const evaluator = new UsageAlertEvaluator();
    const above = windowAt("session", "5-hour", 55, "2026-08-14T16:00:00.000Z");
    const below = windowAt("session", "Session", 12, "2026-08-14T15:58:00.000Z");

    expect(evaluator.evaluate(codexSnapshot([above]), enabledRule)).toEqual([]);
    expect(evaluator.evaluate(codexSnapshot([above, below]), enabledRule)).toEqual([
      expect.objectContaining({ windowKind: "session", remainingPercent: 12 })
    ]);
    expect(evaluator.evaluate(codexSnapshot([above, below]), enabledRule)).toEqual([]);
    expect(evaluator.evaluate(codexSnapshot([below, above]), enabledRule)).toEqual([]);
  });

  it("suppresses a second toast for the same window while the cooldown is active", () => {
    const delivery = new UsageAlertDeliveryLog();
    const alert = {
      providerID: "codex",
      providerName: "Codex",
      windowKind: "session",
      windowLabel: "5-hour",
      thresholdPercent: 40,
      remainingPercent: 38
    };
    const started = Date.parse("2026-08-14T16:00:00.000Z");

    expect(delivery.allow(alert, started)).toBe(true);
    expect(delivery.allow(alert, started + 1_000)).toBe(false);
    expect(delivery.allow({ ...alert, remainingPercent: 31 }, started + 30_000)).toBe(false);
    expect(delivery.allow({ ...alert, windowKind: "weekly" }, started + 1_000)).toBe(true);
    expect(delivery.allow(alert, started + USAGE_ALERT_DELIVERY_COOLDOWN_MS)).toBe(true);
  });

  it("states current and configured remaining capacity in notification copy", () => {
    expect(createUsageAlertNotification({
      providerID: "codex",
      providerName: "Codex",
      windowKind: "weekly",
      windowLabel: "Weekly",
      thresholdPercent: 40,
      remainingPercent: 39.5
    })).toEqual({
      title: "Codex capacity alert",
      body: "Weekly has 39.5% remaining. Your alert is set for 40% remaining."
    });
  });
});

function snapshot(
  remainingPercent: number,
  resetAt: string | null = "cycle-1"
): DashboardSnapshot {
  return codexSnapshot([windowAt("session", "5-hour", remainingPercent, resetAt)]);
}

function windowAt(
  kind: string,
  label: string,
  remainingPercent: number,
  resetAt: string | null
): DashboardWindow {
  return {
    kind,
    label,
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    resetAt
  };
}

function codexSnapshot(windows: DashboardWindow[]): DashboardSnapshot {
  return {
    schemaVersion: 2,
    generatedAt: "2026-07-29T12:00:00.000Z",
    staleAfterSeconds: 180,
    host: {},
    providers: [{
      id: "codex",
      name: "Codex",
      enabled: true,
      source: "fixture",
      windows,
      identity: null,
      credits: null,
      analytics: null,
      error: null,
      updatedAt: "2026-07-29T12:00:00.000Z"
    }]
  };
}
