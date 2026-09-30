import { describe, expect, it } from "vitest";
import { createQoderAdapter, parseQoderUsage } from "./qoder";
describe("Qoder", () => {
  it("keeps shared credit usage separate and accepts both observed casing variants", () => {
    const r = parseQoderUsage({ totalQuota: { quotaSummary: { usedValue: 20, limitValue: 100 } },
      shared_quota: { quota_summary: { used_value: 60, limit_value: 200 } }, nextResetAt: 1790812800 });
    expect(r.windows.map(w => w.usedPercent)).toEqual([20, 30]);
    expect(r.quotaMetrics?.map(m => m.remaining)).toEqual([80, 140]);
    expect(r.windows[0].resetAt).toBe("2026-10-01T00:00:00.000Z");
  });
  it("rejects missing/negative counters and inconsistent zero allowance", () => {
    for (const quotaSummary of [{}, { usedValue: -1, limitValue: 10 }, { usedValue: 1, limitValue: 0 }])
      expect(() => parseQoderUsage({ totalQuota: { quotaSummary } })).toThrow();
    expect(parseQoderUsage({ totalQuota: { quotaSummary: { usedValue: 0, limitValue: 0 } } }).windows[0].usedPercent).toBe(100);
  });
  it("sends China cookies only to the China origin and never follows redirects", async () => {
    const a = createQoderAdapter({ environment: { QODER_COOKIE: "session=test", QODER_REGION: "china" }, fetch: async (url, init) => {
      expect(String(url)).toMatch(/^https:\/\/qoder\.com\.cn\//u);
      expect(new Headers(init?.headers).get("Origin")).toBe("https://qoder.com.cn"); expect(init?.redirect).toBe("error");
      return Response.json({ totalQuota: { quotaSummary: { usedValue: 1, limitValue: 10 } } });
    } });
    expect((await a.refresh({ now: new Date(), signal: new AbortController().signal, historyDays: 30, historyDaysForAccount: () => 30 })).analytics).toBeNull();
  });
});
