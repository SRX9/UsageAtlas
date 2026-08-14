import type { DashboardProvider } from "@usageatlas/contracts";
import { describe, expect, it } from "vitest";
import {
  limitEntries,
  mergeLimitOrder,
  rankedLimitEntries,
  sanitizeLimitOrder,
  sanitizeTrayLimits,
  trayLimitEntries
} from "../../shared/capacity-model";

describe("limitEntries", () => {
  it("keeps one entry per live window and drops tools that are off or failing", () => {
    const providers = [
      provider("codex", true, false, [["weekly", 64], ["session", 21]]),
      provider("claude", true, false, [["session", 42]]),
      provider("cursor", false, false, [["monthly", 8]]),
      provider("opencode", true, true, [["weekly", 5]])
    ];

    expect(limitEntries(providers).map((entry) => [entry.provider.id, entry.window.kind])).toEqual([
      ["codex", "weekly"],
      ["codex", "session"],
      ["claude", "session"]
    ]);
  });

  it("returns an empty list when no active tool reports a live limit", () => {
    expect(limitEntries([provider("codex", true, false, [])])).toEqual([]);
  });
});

describe("rankedLimitEntries", () => {
  it("alternates between tools when nothing has been ranked yet", () => {
    const providers = [
      provider("opencode", true, false, [["weekly", 54]]),
      provider("cursor", true, false, [["plan", 72], ["api", 16]]),
      provider("claude", true, true, [["session", 28]]),
      provider("codex", true, false, [["session", 21], ["weekly", 64]])
    ];

    expect(rankedLimitEntries(providers).map((entry) => [entry.provider.id, entry.window.kind])).toEqual([
      ["codex", "session"],
      ["cursor", "plan"],
      ["opencode", "weekly"],
      ["codex", "weekly"],
      ["cursor", "api"]
    ]);
  });

  it("ranks individual limits, so two tools can interleave their windows", () => {
    const providers = [
      provider("codex", true, false, [["session", 21], ["weekly", 64]]),
      provider("cursor", true, false, [["plan", 72], ["api", 16]])
    ];

    expect(rankedLimitEntries(providers, ["cursor:api", "codex:weekly"])
      .map((entry) => [entry.provider.id, entry.window.kind])).toEqual([
      ["cursor", "api"],
      ["codex", "weekly"],
      ["codex", "session"],
      ["cursor", "plan"]
    ]);
  });
});

describe("trayLimitEntries", () => {
  it("keeps ranked limits until one is switched off", () => {
    const providers = [provider("claude", true, false, [["session", 42], ["weekly", 81]])];

    expect(trayLimitEntries(providers, ["claude:weekly", "claude:session"], { "claude:session": false })
      .map((entry) => entry.window.kind)).toEqual(["weekly"]);
  });
});

describe("mergeLimitOrder", () => {
  it("keeps limits that are offline in their ranked slots", () => {
    expect(mergeLimitOrder(
      ["codex:session", "claude:weekly", "cursor:plan", "opencode:weekly"],
      ["opencode:weekly", "cursor:plan", "codex:session"]
    )).toEqual(["opencode:weekly", "claude:weekly", "cursor:plan", "codex:session"]);
  });

  it("saves a first ranking when nothing was stored before", () => {
    expect(mergeLimitOrder([], ["claude:weekly", "cursor:api"]))
      .toEqual(["claude:weekly", "cursor:api"]);
  });
});

describe("stored preference sanitizing", () => {
  it("drops values that are not limit keys", () => {
    expect(sanitizeLimitOrder(["claude:weekly", "claude", 7, "claude:weekly"]))
      .toEqual(["claude:weekly"]);
    expect(sanitizeTrayLimits({ "claude:weekly": false, "claude:session": "no", bogus: true }))
      .toEqual({ "claude:weekly": false });
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
