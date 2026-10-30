import { describe, it, expect } from "vitest";
import { createZaiAdapter, parseZaiUsage } from "./zai";

function envelope(limits: unknown[], extra: Record<string, unknown> = {}) {
  return { code: 200, success: true, data: { limits, level: "lite", ...extra } };
}
const context = { now: new Date("2026-10-26T12:00:00Z"), signal: new AbortController().signal,
  historyDays: 30, historyDaysForAccount: () => 30 };

describe("z.ai / GLM", () => {
  it("maps the 5-hour and weekly credit windows with reported resets", () => {
    const reading = parseZaiUsage(envelope([
      { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, currentValue: 71, remaining: 1929, nextResetTime: 1786073946574 },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 10000, currentValue: 71, remaining: 9929, nextResetTime: 1786660486998 }
    ]));
    expect(reading.quotaMetrics?.map(m => [m.id, m.label, m.unit, m.used, m.limit, m.remaining]))
      .toEqual([
        ["session", "5 hours", "credits", 71, 2000, 1929],
        ["weekly", "7 days", "credits", 71, 10000, 9929]
      ]);
    expect(reading.quotaMetrics?.[0].resetAt).toBe(new Date(1786073946574).toISOString());
    expect(reading.identity).toEqual({ plan: "lite" });
    expect(reading.windows.map(w => w.kind)).toEqual(["session", "weekly"]);
  });

  it("keeps token allowances in tokens and withholds MCP time limits", () => {
    const reading = parseZaiUsage(envelope([
      { type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 1000, currentValue: 250 },
      { type: "TIME_LIMIT", unit: 5, number: 1, usage: 100, currentValue: 2 },
      { type: "CREDIT_LIMIT", unit: 9, number: 9, usage: 100, currentValue: 1 }
    ]));
    expect(reading.quotaMetrics?.map(m => [m.id, m.unit, m.used, m.limit])).toEqual([["session", "tokens", 250, 1000]]);
    expect(reading.windows[0].usedPercent).toBe(25);
  });

  it("falls back to a reported percentage only when counts are missing", () => {
    const reading = parseZaiUsage(envelope([{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 42 }]));
    expect(reading.quotaMetrics?.[0]).toMatchObject({ id: "weekly", unit: "percent", used: 42, limit: 100 });
    expect(reading.quotaMetrics?.[0].resetAt).toBeNull();
  });

  it("withholds unknown shapes and rejects empty or rejected envelopes", () => {
    expect(() => parseZaiUsage(envelope([]))).toThrow();
    expect(() => parseZaiUsage({ code: 1001, success: false, msg: "Authentication parameter not received" }))
      .toThrow(expect.objectContaining({ code: "auth_required" }));
    expect(() => parseZaiUsage({ code: 500, success: false })).toThrow();
  });

  it("binds the key to the selected region with bearer auth", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const adapter = createZaiAdapter({ environment: { ZAI_API_KEY: "zai-key", ZAI_REGION: "china" }, fetch: async (url, init) => {
      requests.push({ url: String(url), authorization: new Headers(init?.headers).get("Authorization") });
      return Response.json(envelope([{ type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 100, currentValue: 1 }]));
    } });
    const result = await adapter.refresh(context);
    expect(requests).toEqual([{ url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit", authorization: "Bearer zai-key" }]);
    expect(result.quotaMetrics?.[0].id).toBe("session");
  });
});
