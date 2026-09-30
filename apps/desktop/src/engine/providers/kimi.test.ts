import { describe, it, expect } from "vitest";
import { createKimiAdapter, parseKimiUsage } from "./kimi";
describe("Kimi Code", () => {
  it("maps ratio windows without making up request counts", () => {
    const r = parseKimiUsage({ usages: { limit_5h: { used_ratio: 0 }, limit_7d: { used_ratio: 0.125 }, limit_month_total: { used_ratio: 1.1 } } });
    expect(r.windows.map(w => w.usedPercent)).toEqual([0, 12.5, 100]);
    expect(r.quotaMetrics?.map(m => m.unit)).toEqual(["percent", "percent", "percent"]);
    expect(r.quotaMetrics?.[2].used).toBeCloseTo(110);
  });
  it("uses populated legacy counters for matching zero placeholders, but not after reset", () => {
    const usage = { limit: "100", used: "19", resetTime: "2026-09-28T00:00:01Z" };
    expect(parseKimiUsage({ usage, usages: { limit_7d: { used_ratio: 0, reset_time: "2026-09-28T00:00:00Z" } } }).windows[0].usedPercent).toBe(19);
    expect(parseKimiUsage({ usage, usages: { limit_7d: { used_ratio: 0, reset_time: "2026-10-05T00:00:00Z" } } }).windows[0].usedPercent).toBe(0);
  });
  it("withholds missing/invalid counters and retains independent monthly pools", () => {
    expect(() => parseKimiUsage({ usage: { limit: 100 } })).toThrow();
    expect(parseKimiUsage({ usages: { limit_5h: { used_ratio: -1 }, limit_month_total: { used_ratio: 0.2 } } }).windows.map(w => w.kind)).toEqual(["plan"]);
    expect(() => parseKimiUsage({})).toThrow();
  });
  it("binds the credential to its chosen region without cross-region retries", async () => {
    const urls: string[] = [];
    const adapter = createKimiAdapter({ environment: { KIMI_CODE_API_KEY: "key", KIMI_REGION: "global" }, fetch: async url => {
      urls.push(String(url)); return new Response(null, { status: 401 });
    } });
    await expect(adapter.refresh({ now: new Date(), signal: new AbortController().signal, historyDays: 30, historyDaysForAccount: () => 30 })).rejects.toMatchObject({ code: "auth_required" });
    expect(urls).toEqual(["https://api.kimi.ai/coding/v1/usages"]);
  });
});
