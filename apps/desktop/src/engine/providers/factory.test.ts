import { describe, expect, it } from "vitest";
import { createFactoryAdapter, parseFactoryLegacy, parseFactoryLimits } from "./factory";
const now = new Date("2026-09-28T00:00:00Z");
describe("Factory / Droid", () => {
  it.each([undefined, "user-1"])("reads legacy organization usage with optional user ID %s", async user => {
    const urls: URL[] = [];
    const adapter = createFactoryAdapter({ environment: { FACTORY_API_KEY: "key" }, fetch: async input => {
      const url = new URL(String(input)); urls.push(url);
      if (url.pathname.endsWith("/billing/limits")) return Response.json({ usesTokenRateLimitsBilling: false });
      if (url.pathname.endsWith("/auth/me")) return Response.json({ organization: { id: "org-1" }, userProfile: user ? { id: user } : undefined });
      return Response.json({ usage: { standard: { orgTotalTokensUsed: 70, totalAllowance: 100 } } });
    } });
    const r = await adapter.refresh({ now, signal: new AbortController().signal, historyDays: 30, historyDaysForAccount: () => 30 });
    expect(r.windows[0].usedPercent).toBe(70);
    expect(urls.at(-1)?.searchParams.get("userId")).toBe(user ?? null);
    expect(urls.at(-1)?.searchParams.get("useCache")).toBe("true");
  });
  it("maps independent standard/core pools and cents", () => {
    const r = parseFactoryLimits({ limits: { standard: { fiveHour: { usedPercent: 34, secondsRemaining: 3600 } }, core: { weekly: { usedPercent: 10 } } }, extraUsageBalanceCents: 250 }, now);
    expect(r.windows.map(w => w.kind)).toEqual(["session", "core_weekly"]);
    expect(r.windows[0].resetAt).toBe("2026-09-28T01:00:00.000Z");
    expect(r.quotaMetrics?.[2].remaining).toBe(2.5);
  });
  it("resets explicitly expired windows without assuming missing windows are unused", () => {
    expect(parseFactoryLimits({ limits: { standard: { fiveHour: { usedPercent: 80, windowEnd: "2026-09-27T23:00:00Z" } } } }, now).windows[0].usedPercent).toBe(0);
    expect(() => parseFactoryLimits({}, now)).toThrow();
  });
  it("does not divide personal tokens by an organization allowance", () => {
    const r = parseFactoryLegacy({ usage: { standard: { userTokens: 10, orgTotalTokensUsed: 70, totalAllowance: 100, usedRatio: 0.7 } } });
    expect(r.windows[0].usedPercent).toBe(70); expect(r.quotaMetrics?.[1]).toMatchObject({ used: 10, limit: null });
  });
  it("does not fall back to another account after rejected credentials", async () => {
    let calls = 0;
    const a = createFactoryAdapter({ environment: { FACTORY_API_KEY: "key" }, fetch: async () => { calls++; return new Response(null, { status: 401 }); } });
    await expect(a.refresh({ now, signal: new AbortController().signal, historyDays: 30, historyDaysForAccount: () => 30 })).rejects.toMatchObject({ code: "auth_required" });
    expect(calls).toBe(1);
  });
  it("withholds sentinel allowances and does not guess an ambiguous ratio's scale", () => {
    const r = parseFactoryLegacy({ usage: { standard: { usedRatio: 25, orgTotalTokensUsed: 70, totalAllowance: 100 }, premium: { usedRatio: 2, orgTotalTokensUsed: 40, totalAllowance: 1e15 } } });
    expect(r.windows.map(w => w.usedPercent)).toEqual([70]);
    expect(r.quotaMetrics?.[1]).toMatchObject({ used: 40, limit: null, remaining: null });
    expect(parseFactoryLegacy({ usage: { standard: { usedRatio: 0, orgTotalTokensUsed: 30, totalAllowance: 100 } } }).windows[0].usedPercent).toBe(30);
  });
});
