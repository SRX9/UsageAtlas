import { describe, expect, it, vi } from "vitest";
import { fetchCursorUsageHistory } from "./cursor-usage";

const now = new Date("2026-08-09T12:00:00.000Z");

describe("Cursor usage history", () => {
  it("removes only proven adjacent page overlap before publishing totals", async () => {
    const first = event("2026-08-09T09:00:00.000Z", "model-a", 1, 10);
    const boundary = event("2026-08-09T10:00:00.000Z", "model-b", 2, 20);
    const last = event("2026-08-09T11:00:00.000Z", "model-c", 3, 30);
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const page = Number((JSON.parse(String(init?.body)) as { page: number }).page);
      const rows = page === 1 ? [first, boundary] : page === 2 ? [boundary, last] : [];
      return Response.json({
        totalUsageEventsCount: 3,
        usageEventsDisplay: rows
      });
    });

    const analytics = await fetchCursorUsageHistory(
      { now, signal: new AbortController().signal },
      {},
      { fetch: request, historyDays: 1, maxEvents: 6, pageSize: 2 }
    );

    expect(request).toHaveBeenCalledTimes(3);
    expect(analytics.recordsProcessed).toBe(3);
    expect(analytics.totals).toMatchObject({
      inputTokens: 300,
      totalTokens: 330,
      requests: 3,
      estimatedCostUSD: 0.06
    });
  });

  it("rejects a full safety-cap page instead of publishing a partial total", async () => {
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const page = Number((JSON.parse(String(init?.body)) as { page: number }).page);
      return Response.json({
        totalUsageEventsCount: 4,
        usageEventsDisplay: [
          event(`2026-08-09T0${page}:00:00.000Z`, `model-${page}-a`, 1, 1),
          event(`2026-08-09T0${page}:30:00.000Z`, `model-${page}-b`, 1, 1)
        ]
      });
    });

    await expect(fetchCursorUsageHistory(
      { now, signal: new AbortController().signal },
      {},
      { fetch: request, historyDays: 1, maxEvents: 4, pageSize: 2 }
    )).rejects.toThrow("Cursor usage history was incomplete");
  });
});

function event(timestamp: string, model: string, totalCents: number, chargedCents: number) {
  return {
    timestamp: String(Date.parse(timestamp)),
    model,
    kind: "USAGE_EVENT_KIND_USAGE_BASED",
    isTokenBasedCall: true,
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 10,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      totalCents
    },
    chargedCents,
    isChargeable: true,
    isHeadless: false
  };
}
