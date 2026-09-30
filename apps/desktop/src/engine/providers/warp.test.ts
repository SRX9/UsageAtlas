import { describe, expect, it } from "vitest";
import { parseWarpUsage, createWarpAdapter } from "./warp";
const now = new Date("2026-09-28T00:00:00Z");
const payload = (info: object, rest: object = {}) => ({ data: { user: { user: { requestLimitInfo: info, ...rest } } } });
describe("Warp credits", () => {
  it("records credits without fabricating token/request history", async () => {
    const adapter = createWarpAdapter({ environment: { WARP_API_KEY: "test-key" }, fetch: async (url, init) => {
      expect(url).toBe("https://app.warp.dev/graphql/v2?op=GetRequestLimitInfo"); expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-key");
      return Response.json(payload({ isUnlimited: false, requestLimit: 100, requestsUsedSinceLastRefresh: 25, nextRefreshTime: "2026-10-01T00:00:00Z" }));
    } });
    const result = await adapter.refresh({ now, signal: new AbortController().signal, historyDays: 30, historyDaysForAccount: () => 30 });
    expect(result.analytics).toBeNull(); expect(result.windows[0].usedPercent).toBe(25);
    expect(result.quotaMetrics?.[0]).toMatchObject({ unit: "credits", used: 25, limit: 100 });
    expect(JSON.stringify(result)).not.toContain("test-key");
  });
  it("keeps personal and workspace grants separate and ignores expired grants", () => {
    const result = parseWarpUsage(payload({ isUnlimited: true, requestsUsedSinceLastRefresh: 0 }, {
      bonusGrants: [{ requestCreditsGranted: 50, requestCreditsRemaining: 20, expiration: "2026-10-01T00:00:00Z" },
        { requestCreditsGranted: 100, requestCreditsRemaining: 80, expiration: "2026-01-01T00:00:00Z" }],
      workspaces: [{ bonusGrantsInfo: { grants: [{ requestCreditsGranted: 200, requestCreditsRemaining: 100 }] } }]
    }), now);
    expect(result.windows.map(w => w.kind)).toEqual(["bonus", "workspace_1"]);
    expect(result.windows[0].resetAt).toBeNull(); expect(result.quotaMetrics?.[1].remaining).toBe(20);
  });
  it("rejects missing counters and GraphQL errors, preserves explicit exhausted allowance", () => {
    expect(() => parseWarpUsage(payload({ isUnlimited: false }), now)).toThrow();
    expect(() => parseWarpUsage({ errors: [{ message: "secret response" }] }, now)).toThrow("invalid usage");
    expect(parseWarpUsage(payload({ isUnlimited: false, requestLimit: 0, requestsUsedSinceLastRefresh: 0 }), now).windows[0].usedPercent).toBe(100);
  });
});
