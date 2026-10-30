import { describe, expect, it } from "vitest";
import type { ReportPlan } from "../../shared/report-plans";
import { spinTarget } from "./report-wheel";
import { previewPlan, tokenTarget } from "../../shared/report-wheel";

const wheel: ReportPlan = {
  source: "freebuff" as ReportPlan["source"],
  targets: [
    { reportAs: "codex", model: "gpt-5.3-codex", weight: 30 },
    { reportAs: "claude", model: "claude-sonnet-4-6", weight: 20 },
    { reportAs: "cursor", model: "composer-2.5", weight: 50 }
  ]
};

/** One thousand draws, the way a day of requests arrives. */
function draws(): Record<string, number> {
  const counts: Record<string, number> = { codex: 0, claude: 0, cursor: 0 };
  for (let index = 0; index < 1_000; index += 1) {
    const target = spinTarget(wheel, `request-${index}`);
    counts[target!.reportAs] += 1;
  }
  return counts;
}

describe("report wheel", () => {
  it("lands on each target about as often as its weight says", () => {
    const counts = draws();

    for (const [provider, weight] of [["codex", 30], ["claude", 20], ["cursor", 50]] as const) {
      expect(Math.abs(counts[provider] - weight * 10), provider).toBeLessThanOrEqual(60);
    }
    expect(counts.codex + counts.claude + counts.cursor).toBe(1_000);
  });

  it("repeats a target instead of taking turns", () => {
    const picks = Array.from({ length: 40 }, (_value, index) => spinTarget(wheel, `request-${index}`)!.reportAs);
    const repeats = picks.filter((provider, index) => index > 0 && provider === picks[index - 1]);

    expect(repeats.length).toBeGreaterThan(0);
  });

  it("gives one request the same target every time it is saved again", () => {
    const first = spinTarget(wheel, "request-7");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(spinTarget(wheel, "request-7")).toEqual(first);
    }
  });

  it("uses the whole wheel when a source is not the only one spinning", () => {
    const other: ReportPlan = { ...wheel, source: "zai" as ReportPlan["source"] };
    const here = Array.from({ length: 200 }, (_value, index) => spinTarget(wheel, `request-${index}`)!.reportAs);
    const there = Array.from({ length: 200 }, (_value, index) => spinTarget(other, `request-${index}`)!.reportAs);

    // Different sources are independent wheels: one is not a rotation of the other.
    expect(here).not.toEqual(there);
  });

  it("previews the exact token split", () => {
    const preview = previewPlan(wheel);

    expect(preview.targets.map((target) => Math.round(target.declared * 100))).toEqual([30, 20, 50]);
    expect(preview.totalWeight).toBe(100);
  });

  it("splits token mass, not request count", () => {
    const assigned = new Map<string, number>();
    const pick = (tokens: number) => {
      const target = tokenTarget(wheel, (entry) => assigned.get(entry.reportAs) ?? 0, tokens)!;
      assigned.set(target.reportAs, (assigned.get(target.reportAs) ?? 0) + tokens);
      return target.reportAs;
    };
    // Requests of very different sizes: a per-request wheel would keep counting
    // them evenly, while mass allocation sends each one where the deficit is.
    const sizes = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233].map((size) => size * 1_000_000);
    for (let round = 0; round < 8; round += 1) {
      for (const size of sizes) pick(size);
    }

    const total = [...assigned.values()].reduce((sum, tokens) => sum + tokens, 0);
    for (const [provider, share] of [
      ["codex", 0.3], ["claude", 0.2], ["cursor", 0.5]
    ] as const) {
      const actual = (assigned.get(provider) ?? 0) / total;
      expect(Math.abs(actual - share), provider).toBeLessThanOrEqual(0.03);
    }
  });

  it("reports nothing without a plan or with no weight", () => {
    expect(spinTarget(null, "request-1")).toBeNull();
    expect(spinTarget({ source: "freebuff" as ReportPlan["source"], targets: [] }, "request-1")).toBeNull();
    expect(spinTarget({ source: "freebuff" as ReportPlan["source"], targets: [{ reportAs: "codex", model: "gpt-5.5", weight: 0 }] }, "request-1")).toBeNull();
  });
});
