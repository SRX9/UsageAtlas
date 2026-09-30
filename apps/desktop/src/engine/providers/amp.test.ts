import { describe, expect, it } from "vitest";
import { parseAmpUsage } from "./amp";
const now = new Date("2026-09-28T01:00:00Z");
describe("Amp", () => {
  it("uses exact Agent dollars and Orb hours rather than rounded percentages", () => {
    const r = parseAmpUsage("Amp Megawatt Tier: agent usage $18.57 of $20 remaining (93%), orb usage 4.5h of 100h a1.small orb hours remaining - period 2026-09-01 to 2026-10-01, resets upon renewal in 3 days\nIndividual credits: $17.23 remaining\nWorkspace private-name: $5.33 remaining", now);
    expect(r.quotaMetrics?.[0].used).toBeCloseTo(1.43);
    expect(r.quotaMetrics?.[1]).toMatchObject({ used: 95.5, remaining: 4.5, unit: "hours", resetAt: "2026-10-01T00:00:00.000Z" });
    expect(r.quotaMetrics?.[2].remaining).toBe(17.23); expect(JSON.stringify(r)).not.toContain("private-name");
  });
  it("preserves daily free usage and independent legacy subscription pools", () => {
    const r = parseAmpUsage("Amp Free: 61% remaining today (resets daily)\nSubscription Gigawatt: 73% other usage and 91% orb usage remaining - resets upon renewal in 1 month", now);
    expect(r.windows.map(w => w.usedPercent)).toEqual([39, 27, 9]);
    expect(r.windows[0].resetAt).toBe("2026-09-29T00:00:00.000Z"); expect(r.windows[1].resetAt).toBeNull();
  });
  it("keeps replenishing money distinct from credits and rejects unrecognized output", () => {
    const r = parseAmpUsage("Amp Free: $8/$10 remaining (replenishes +$0.5/hour)", now);
    expect(r.quotaMetrics?.[0]).toMatchObject({ used: 2, limit: 10, unit: "USD", resetAt: null });
    expect(() => parseAmpUsage("Signed in as user@example.com", now)).toThrow();
    expect(parseAmpUsage("Amp Tier: invalid\nIndividual credits: $0 remaining", now).windows).toEqual([]);
  });
});
