import { describe, expect, it } from "vitest";
import {
  applyTargetToFact,
  applyTargetToRecord,
  planFromLegacyAliases,
  planFor,
  planWeight,
  targetShare,
  validateReportPlans,
  type ReportPlan
} from "./report-plans";
import type { UsageFact } from "@usageatlas/contracts/statistics";
import type { UsageRecord } from "@usageatlas/contracts/usage";

const plan = (targets: ReportPlan["targets"], source = "freebuff"): ReportPlan => ({ source: source as ReportPlan["source"], targets });
/** One day of usage, as the local history stores it. */
const day = (overrides: Record<string, unknown>): UsageRecord => ({ kind: "usage_day", ...overrides }) as unknown as UsageRecord;

describe("report plans", () => {
  it("keeps one plan per source and drops what the server cannot be told", () => {
    const plans = validateReportPlans([
      plan([{ reportAs: "codex", model: "gpt-5.3-codex", weight: 30 }, { reportAs: "claude", model: "claude-opus-5", weight: 70 }]),
      plan([{ reportAs: "codex", model: "gpt-5.5", weight: 50 }], "freebuff"),
      plan([{ reportAs: "codex", model: "gpt-5.5", weight: 50 }], "not-a-provider"),
      plan([{ reportAs: "not-official", model: "gpt-5.5", weight: 50 } as unknown as ReportPlan["targets"][number]], "zai"),
      plan([{ reportAs: "codex", model: "  ", weight: 50 }], "zai"),
      plan([{ reportAs: "codex", model: "gpt-5.5", weight: 0 }], "zai"),
      plan([{ reportAs: "codex", model: "gpt-5.5", weight: 1.5 }], "zai"),
      plan([{ reportAs: "codex", model: "gpt-5.5", weight: 2_000 }], "zai"),
      plan([{ reportAs: "codex", model: "gpt 5.5", weight: 50 }], "zai"),
      plan([{ reportAs: "codex", model: "gpt-5.5", weight: 50 }, { reportAs: "codex", model: "gpt-5.5", weight: 50 }], "zai"),
      plan([], "zai")
    ]);

    expect(plans).toEqual([
      plan([{ reportAs: "codex", model: "gpt-5.3-codex", weight: 30 }, { reportAs: "claude", model: "claude-opus-5", weight: 70 }]),
      // The repeated pair keeps the first entry only.
      plan([{ reportAs: "codex", model: "gpt-5.5", weight: 50 }], "zai")
    ]);
  });

  it("reads single-target rules from older builds as one-target plans", () => {
    expect(planFromLegacyAliases([
      { source: "freebuff", reportAs: "codex", model: "gpt-5.3-codex" },
      { source: "freebuff", reportAs: "claude", model: "claude-opus-5" },
      { source: "zai", reportAs: "freebuff", model: "glm-4.6" }
    ])).toEqual([plan([{ reportAs: "codex", model: "gpt-5.3-codex", weight: 100 }])]);
  });

  it("keeps an opaque model key exactly as the user saved it", () => {
    expect(validateReportPlans([plan([{ reportAs: "codex", model: "gpt-private-2026", weight: 100 }])])).toEqual([
      plan([{ reportAs: "codex", model: "gpt-private-2026", weight: 100 }])
    ]);
  });

  it("reports one source's models under the model the target names", () => {
    const target = { reportAs: "codex", model: "gpt-5.3-codex", weight: 100 } as const;
    const record = day({
      providerId: "freebuff",
      models: [{ modelKey: "glm-4.6", totals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, requests: 1 } }]
    });
    const rewritten = applyTargetToRecord(record, target);

    expect(rewritten.providerId).toBe("codex");
    expect((rewritten as unknown as { models: unknown[] }).models).toEqual([{ modelKey: "gpt-5.3-codex", totals: expect.objectContaining({ totalTokens: 15, requests: 1 }) }]);

    const event = { kind: "usage_event", providerId: "freebuff", eventId: "e1", modelKey: "glm-4.6" } as unknown as UsageFact;
    expect(applyTargetToFact(event, target)).toMatchObject({ providerId: "codex", modelKey: "gpt-5.3-codex", reportedModel: "gpt-5.3-codex" });
  });

  it("finds a plan by the local source and shares out its weights", () => {
    const wheel = plan([{ reportAs: "codex", model: "gpt-5.3-codex", weight: 30 }, { reportAs: "claude", model: "claude-opus-5", weight: 20 }]);

    expect(planFor([wheel], "freebuff")).toBe(wheel);
    expect(planFor([wheel], "zai")).toBeNull();
    expect(planWeight(wheel)).toBe(50);
    expect(targetShare(wheel, wheel.targets[0])).toBeCloseTo(0.6);
    expect(targetShare(wheel, wheel.targets[1])).toBeCloseTo(0.4);
  });
});
