import type { DashboardSnapshot } from "@usageatlas/contracts";
import type { UsageAlertPreferences } from "../shared/desktop-api";
import { describe, expect, it } from "vitest";
import { createUsageAlertNotification, UsageAlertEvaluator } from "./usage-alerts";

const enabledRule: UsageAlertPreferences = {
  codex: { session: { enabled: true, thresholdPercent: 40 } }
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
      windows: [{
        kind: "session",
        label: "5-hour",
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        resetAt
      }],
      identity: null,
      credits: null,
      analytics: null,
      error: null,
      updatedAt: "2026-07-29T12:00:00.000Z"
    }]
  };
}
