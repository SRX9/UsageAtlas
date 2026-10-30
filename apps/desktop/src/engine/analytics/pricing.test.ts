import { afterEach, describe, expect, it } from "vitest";
import { configurePricing, estimateClaudeCost, estimateCodexCost } from "./pricing";
import { estimateSessionCost } from "./session-source";
import type { UsageRecord } from "./local-usage";

describe("blended cost estimate", () => {
  afterEach(() => configurePricing({ blendedCostPerMillion: null }));

  it("prices every Codex token at the same rate", () => {
    configurePricing({ blendedCostPerMillion: 0.54 });

    const cost = estimateCodexCost({
      model: "m-096e75164d",
      inputTokens: 1_604_679,
      cachedInputTokens: 1_587_456,
      cacheCreationInputTokens: 0,
      outputTokens: 8_828
    });

    expect(cost).toBeCloseTo(0.871294, 6);
  });

  it("prices Claude cache buckets at the same rate", () => {
    configurePricing({ blendedCostPerMillion: 0.54 });

    const cost = estimateClaudeCost({
      model: "claude-sonnet-5",
      inputTokens: 500_000,
      cachedInputTokens: 250_000,
      cacheCreationInputTokens: 150_000,
      outputTokens: 100_000
    });

    expect(cost).toBeCloseTo(0.54, 6);
  });

  it("falls back to per-model prices when the blended rate is cleared", () => {
    configurePricing({ blendedCostPerMillion: null });

    const cost = estimateSessionCost({
      model: "claude-sonnet-5",
      modelProvider: "anthropic",
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
      totalTokens: 1_000_000
    } as unknown as UsageRecord);

    expect(cost).not.toBeNull();
    expect(cost).not.toBeCloseTo(0.54, 6);
  });
});
