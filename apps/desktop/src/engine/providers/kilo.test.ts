import { describe, expect, it } from "vitest";
import { parseKiloUsage } from "./kilo";
const now = new Date("2026-09-28T00:00:00Z");
const batch = (credits: unknown, pass: unknown = {}) => [{ result: { data: credits } }, { result: { data: { json: pass } } }];
describe("Kilo Code", () => {
  it("converts microdollars and keeps Pass and credit blocks separate", () => {
    const r = parseKiloUsage(batch({ creditBlocks: [{ amount_mUsd: 19e6, balance_mUsd: 10e6 }] }, {
      subscription: { currentPeriodUsageUsd: 3.5, currentPeriodBaseCreditsUsd: 19, currentPeriodBonusCreditsUsd: 9.5, nextBillingAt: "2026-10-01T00:00:00Z" }
    }), now);
    expect(r.quotaMetrics?.[0]).toMatchObject({ used: 9, remaining: 10, limit: 19, unit: "USD" });
    expect(r.quotaMetrics?.[1]).toMatchObject({ used: 3.5, limit: 28.5, unit: "USD" });
  });
  it("does not convert a balance-only account into a fabricated zero-use allowance", () => {
    const r = parseKiloUsage(batch({ totalBalance_mUsd: 20e6, creditBlocks: [] }), now);
    expect(r.windows).toEqual([]); expect(r.quotaMetrics?.[0]).toMatchObject({ used: null, limit: null, remaining: 20 });
  });
  it("does not sum expired or future credits and rejects tRPC auth errors", () => {
    const r = parseKiloUsage(batch({ creditBlocks: [{ amount_mUsd: 2e6, balance_mUsd: 1e6 },
      { amount_mUsd: 8e6, balance_mUsd: 8e6, expiry_date: "2026-01-01T00:00:00Z" }] }), now);
    expect(r.quotaMetrics?.[0].limit).toBe(2);
    expect(() => parseKiloUsage([{ error: { json: { data: { code: "UNAUTHORIZED" } } } }], now)).toThrow("rejected");
    expect(() => parseKiloUsage([], now)).toThrow();
  });
});
