import { describe, expect, it } from "vitest";
import { parseCopilotUsage } from "./copilot";
describe("GitHub Copilot", () => {
  it.each([-75, "-75"])("retains overage when remaining is %s", remaining => {
    const r = parseCopilotUsage({ quota_snapshots: { premium_interactions: { entitlement: 500, remaining, percent_remaining: -15 } } });
    expect(r.quotaMetrics?.[0]).toMatchObject({ used: 575, limit: 500, remaining: 0, unit: "requests" });
    expect(r.windows[0].usedPercent).toBe(100);
    expect(parseCopilotUsage({ quota_snapshots: { premium_interactions: { percent_remaining: "-15" } } }).quotaMetrics?.[0])
      .toMatchObject({ used: 115, limit: 100, remaining: 0, unit: "percent" });
  });
  it.each([undefined, "invalid"])("uses chat seat credits when premium reports %s", credits_used => {
    const r = parseCopilotUsage({ token_based_billing: true, quota_snapshots: {
      premium_interactions: { credits_used }, chat: { entitlement: 0, remaining: 0, percent_remaining: 100, credits_used: 31 }
    } });
    expect(r.windows).toEqual([]);
    expect(r.quotaMetrics).toEqual([expect.objectContaining({ id: "seat_credits", used: 31, limit: null })]);
  });
  it("preserves an explicit zero premium pool instead of using chat's duplicate", () => {
    const r = parseCopilotUsage({ token_based_billing: true, quota_snapshots: {
      premium_interactions: { credits_used: 0 }, chat: { credits_used: 31 }
    } });
    expect(r.quotaMetrics).toEqual([expect.objectContaining({ id: "seat_credits", used: 0 })]);
  });
  it("withholds bars for credit-billed 0/0 seats and never doubles credits", () => {
    const r = parseCopilotUsage({ token_based_billing: true, copilot_plan: "business", quota_snapshots: {
      premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 100, credits_used: 31 },
      chat: { entitlement: 0, remaining: 0, percent_remaining: 100, credits_used: 31 }
    } });
    expect(r.windows).toEqual([]); expect(r.quotaMetrics).toHaveLength(1);
    expect(r.quotaMetrics?.[0]).toMatchObject({ used: 31, limit: null, remaining: null, unit: "credits" });
  });
  it("uses explicit counts and retains reported resets", () => {
    const r = parseCopilotUsage({ quota_reset_date: "2026-10-01", quota_snapshots: {
      premium_interactions: { entitlement: 300, remaining: 75, percent_remaining: 25, credits_used: 0 }
    } });
    expect(r.windows[0]).toMatchObject({ usedPercent: 75, resetAt: "2026-10-01T00:00:00.000Z" });
    expect(r.quotaMetrics).toHaveLength(1);
  });
  it("handles legacy allowances and unlimited seats without making up limits", () => {
    expect(parseCopilotUsage({ monthly_quotas: { completions: 300 }, limited_user_quotas: { completions: 75 } }).windows[0].usedPercent).toBe(75);
    expect(parseCopilotUsage({ quota_snapshots: { premium_interactions: { unlimited: true } } }).windows).toEqual([]);
    expect(() => parseCopilotUsage({ quota_snapshots: { premium_interactions: {} } })).toThrow();
  });
});
