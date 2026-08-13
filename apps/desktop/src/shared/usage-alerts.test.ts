import { describe, expect, it } from "vitest";
import {
  cloneUsageAlertPreferences,
  DEFAULT_USAGE_ALERT_THRESHOLD,
  isUsageAlertPreferences,
  sanitizeUsageAlertPreferences
} from "./usage-alerts";

describe("usage alert preferences", () => {
  it("defaults to alerting when 20% capacity remains", () => {
    expect(DEFAULT_USAGE_ALERT_THRESHOLD).toBe(20);
  });

  it("accepts bounded integer thresholds and rejects malformed rules", () => {
    expect(isUsageAlertPreferences({
      codex: { weekly: { enabled: true, thresholdPercent: 85 } }
    })).toBe(true);
    expect(isUsageAlertPreferences({
      codex: { weekly: { enabled: true, thresholdPercent: 0 } }
    })).toBe(true);
    expect(isUsageAlertPreferences({
      codex: { weekly: { enabled: true, thresholdPercent: 85.5 } }
    })).toBe(false);
    expect(isUsageAlertPreferences({
      codex: { weekly: { enabled: true, thresholdPercent: 101 } }
    })).toBe(false);
    expect(isUsageAlertPreferences({
      codex: { weekly: { enabled: true, thresholdPercent: 85, extra: true } }
    })).toBe(false);
  });

  it("drops invalid persisted entries without losing valid provider rules", () => {
    expect(sanitizeUsageAlertPreferences({
      codex: {
        session: { enabled: true, thresholdPercent: 80 },
        invalid: { enabled: true, thresholdPercent: -1 }
      },
      "Not Safe": {
        weekly: { enabled: true, thresholdPercent: 90 }
      }
    })).toEqual({
      codex: { session: { enabled: true, thresholdPercent: 80 } }
    });
  });

  it("clones nested rules before exposing stored preferences", () => {
    const original = {
      codex: { session: { enabled: true, thresholdPercent: 80 } }
    };
    const cloned = cloneUsageAlertPreferences(original);

    cloned.codex!.session!.thresholdPercent = 90;
    expect(original.codex.session.thresholdPercent).toBe(80);
  });
});
