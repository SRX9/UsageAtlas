import { PUBLIC_MODELS } from "@usageatlas/contracts/usage";
import { describe, expect, it } from "vitest";
import { OFFICIAL_PROVIDERS } from "./report-plans";
import { defaultReportedModel, modelOptions, reportedModels } from "./report-models";

describe("reported model catalog", () => {
  it("offers every provider a non-empty list of models the server displays", () => {
    for (const provider of OFFICIAL_PROVIDERS) {
      const models = reportedModels(provider);
      expect(models.length, provider).toBeGreaterThan(0);
      for (const model of models) {
        expect(PUBLIC_MODELS.has(model), `${provider}:${model}`).toBe(true);
      }
    }
  });

  it("keeps a rule's own model selectable without losing the catalog", () => {
    expect(modelOptions("codex", "gpt-5.3-codex")).toEqual(reportedModels("codex"));
    const saved = modelOptions("codex", "gpt-private-2026");
    expect(saved[0]).toBe("gpt-private-2026");
    expect(saved).toContain("gpt-5.6-sol");
  });

  it("starts a new rule on the provider's first model", () => {
    expect(defaultReportedModel("codex")).toBe("gpt-5.6-sol");
    expect(defaultReportedModel("cursor")).toBe("composer-2.5");
  });
});
