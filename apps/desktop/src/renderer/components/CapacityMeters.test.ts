import type { DashboardProvider } from "@usageatlas/contracts";
import { describe, expect, it } from "vitest";
import {
  limitEntries,
  mergeLimitProviderOrder,
  previewLimitEntries,
  rankedLimitProviders
} from "../../shared/capacity-model";

describe("limitEntries", () => {
  it("keeps enabled healthy limits and orders the most constrained first", () => {
    const providers = [
      provider("codex", true, false, [["weekly", 64], ["session", 21]]),
      provider("claude", true, false, [["session", 42]]),
      provider("cursor", false, false, [["monthly", 8]]),
      provider("opencode", true, true, [["weekly", 5]])
    ];

    expect(limitEntries(providers).map((entry) => [
      entry.provider.id,
      entry.window.kind,
      entry.window.remainingPercent
    ])).toEqual([
      ["codex", "session", 21],
      ["claude", "session", 42],
      ["codex", "weekly", 64]
    ]);
  });

  it("returns an empty list when no active tool reports a live limit", () => {
    expect(limitEntries([provider("codex", true, false, [])])).toEqual([]);
  });
  it("shows one limit per ranked tool and lets the next connected tool fill an empty slot", () => {
    const providers = [
      provider("opencode", true, false, [["weekly", 54]]),
      provider("cursor", true, false, [["plan", 72], ["on-demand", 16]]),
      provider("claude", true, true, [["session", 28]]),
      provider("codex", true, false, [["weekly", 64], ["session", 21]]),
      provider("gemini", true, false, [["daily", 80]])
    ];

    expect(previewLimitEntries(providers).map((entry) => [entry.provider.id, entry.window.kind])).toEqual([
      ["codex", "session"],
      ["cursor", "plan"],
      ["opencode", "weekly"],
      ["gemini", "daily"]
    ]);
  });

  it("uses a saved ranking before the default provider order", () => {
    const providers = [
      provider("codex", true, false, [["session", 50]]),
      provider("claude", true, false, [["session", 50]])
    ];
    expect(rankedLimitProviders(providers, ["claude", "codex"]).map(({ id }) => id))
      .toEqual(["claude", "codex"]);
  });

  it("keeps hidden tools in their ranked slots when visible tools are reordered", () => {
    expect(mergeLimitProviderOrder(
      ["codex", "claude", "cursor", "opencode"],
      ["opencode", "cursor", "codex"]
    )).toEqual(["opencode", "claude", "cursor", "codex"]);
  });
});

function provider(
  id: string,
  enabled: boolean,
  hasError: boolean,
  windows: Array<[string, number]>
): DashboardProvider {
  return {
    id,
    name: id,
    enabled,
    source: "fixture",
    windows: windows.map(([kind, remainingPercent]) => ({
      kind,
      label: kind,
      remainingPercent,
      usedPercent: 100 - remainingPercent
    })),
    analytics: null,
    error: hasError
      ? { code: "test_error", message: "Unavailable", retryable: true }
      : null
  };
}
