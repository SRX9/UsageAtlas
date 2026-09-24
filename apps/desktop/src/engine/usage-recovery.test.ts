import cursorFixture from "@usageatlas/contracts/fixtures/providers/cursor-usage-summary.json";
import type { JsonValue } from "@usageatlas/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardSession } from "../main/dashboard-session";
import { validateDashboard } from "../main/dashboard-validation";
import { EngineService } from "./engine-service";
import { MemoryHistoryStore } from "./history/memory-store";
import { SqliteHistoryStore } from "./history/sqlite-store";
import type { EngineMethod } from "./protocol";
import { createCursorAdapter, parseCursorUsage } from "./providers/cursor";

const stores: SqliteHistoryStore[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
});

async function request(engine: EngineService, method: EngineMethod, params: Record<string, JsonValue>) {
  const response = await engine.handle({ id: "recovery-test", method, params });
  if (!response.ok) throw new Error(response.error.message);
  return response.result;
}

describe("usage recovery", () => {
  it.each(["", "saved-account"])("keeps local collection working without SQLite for account %j", async accountId => {
    const now = new Date("2026-09-10T20:00:00Z");
    const refresh = vi.fn(async () => parseCursorUsage(cursorFixture, now));
    const engine = new EngineService([{ id: "cursor", name: "Cursor", refresh }], () => now, new MemoryHistoryStore());
    const snapshot = (params: Record<string, JsonValue>) => request(engine, "snapshot.get", params).then(validateDashboard);
    const dashboard = new DashboardSession({
      getHydratedSnapshot: () => snapshot({ hydrateOnly: true }),
      getSnapshot: () => snapshot({ force: false }),
      refreshAll: () => snapshot({ force: true }),
      setProviderEnabled: async (provider, enabled) => {
        await request(engine, "config.update", { provider, enabled });
        return snapshot({ force: false });
      }
    }, () => {});
    try {
      await dashboard.configure(accountId, () => request(engine, "cloud", {
        operation: "configure", accountId, token: accountId ? "fixture" : "", baseURL: "https://usageatlas.example"
      }));
      dashboard.activate();
      const current = await dashboard.refresh(true);
      expect(current).toMatchObject({ refreshing: false, error: null });
      expect(current.snapshot?.providers[0]?.windows).toEqual(parseCursorUsage(cursorFixture, now).windows);
      expect(refresh).toHaveBeenCalledOnce();
      const disabled = await dashboard.setProviderEnabled("cursor", false);
      expect(disabled.snapshot?.providers[0]?.enabled).toBe(false);
      expect(refresh).toHaveBeenCalledOnce();
      await expect(request(engine, "cloud", { operation: "save" })).rejects.toThrow("requires local SQLite storage");
      await expect(request(engine, "cloud", { operation: "configure", accountId })).rejects.toThrow("Invalid account configuration");
    } finally {
      dashboard.close();
    }
  });

  it("recovers tokens and cost after a Cursor history timeout across midnight without double counting", async () => {
    vi.useFakeTimers();
    let now = new Date("2026-09-10T20:00:00Z");
    let timeoutHistory = false;
    const store = SqliteHistoryStore.open(":memory:");
    stores.push(store);
    store.usage.setSetting("reporting-timezone", "UTC");
    const events = [
      { timestamp: "2026-09-09T12:00:00Z", model: "gpt-5", tokenUsage: { inputTokens: 10, outputTokens: 0, totalCents: 0.1 } },
      { timestamp: "2026-09-10T12:00:00Z", model: "gpt-5", tokenUsage: { inputTokens: 100, outputTokens: 0, totalCents: 1 } },
      { timestamp: "2026-09-10T23:50:00Z", model: "gpt-5", tokenUsage: { inputTokens: 200, outputTokens: 0, totalCents: 2 } },
      { timestamp: "2026-09-11T00:01:00Z", model: "gpt-5", tokenUsage: { inputTokens: 50, outputTokens: 0, totalCents: 0.5 } }
    ];
    let historyRequests = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).endsWith("usage-summary")) return Response.json(cursorFixture);
      historyRequests++;
      if (timeoutHistory) return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
      const body = JSON.parse(String(init?.body));
      const rows = events.filter(row => Date.parse(row.timestamp) >= Number(body.startDate) && Date.parse(row.timestamp) <= Number(body.endDate));
      return Response.json({ usageEventsDisplay: rows, totalUsageEventsCount: rows.length });
    });
    const token = `header.${Buffer.from(JSON.stringify({ sub: "auth0|cursor-user", exp: 2_000_000_000 })).toString("base64url")}.signature`;
    const cursor = createCursorAdapter({
      fetch,
      sqliteFactory: { open: () => ({ get: () => ({ value: token }), all: () => [], close: () => {} }) }
    });
    const lookbacks: number[] = [];
    const engine = new EngineService([{
      ...cursor,
      isAvailable: async () => true,
      refresh: context => {
        lookbacks.push(context.historyDaysForAccount("cursor-user"));
        return cursor.refresh(context);
      }
    }], () => now, store);
    const read = () => request(engine, "snapshot.get", { force: true }).then(validateDashboard);

    await read();
    await vi.runAllTimersAsync();
    expect(store.get("cursor", "cursor-user", "2026-09-10")).toMatchObject({ sealed: false, payload: { totals: { totalTokens: 100 } } });
    now = new Date("2026-09-11T00:02:00Z");
    timeoutHistory = true;
    const pending = read();
    await vi.waitFor(() => expect(historyRequests).toBe(2));
    await vi.advanceTimersByTimeAsync(60_000);
    const failed = await pending;
    await vi.runAllTimersAsync();
    expect(failed.providers[0]?.windows).toEqual(parseCursorUsage(cursorFixture, now).windows);
    expect(failed.providers[0]?.analytics).toMatchObject({ status: "partial", error: { code: "timeout" } });
    expect(store.get("cursor", "cursor-user", "2026-09-10")?.sealed).toBe(false);

    timeoutHistory = false;
    now = new Date("2026-09-11T00:05:00Z");
    const recovered = await read();
    await vi.runAllTimersAsync();
    const yesterday = store.get("cursor", "cursor-user", "2026-09-10");
    expect(yesterday).toMatchObject({ sealed: true, payload: { totals: { totalTokens: 300, requests: 2 } } });
    expect(yesterday?.payload.totals.estimatedCostUSD).toBeCloseTo(0.03);
    expect(recovered.providers[0]?.analytics).toMatchObject({ status: "available", error: null, today: { totalTokens: 50 }, totals: { totalTokens: 360 } });
    expect(recovered.providers[0]?.analytics?.totals.estimatedCostUSD).toBeCloseTo(0.036);
    const repeated = await read();
    expect(repeated.providers[0]?.analytics?.totals).toEqual(recovered.providers[0]?.analytics?.totals);
    expect(lookbacks).toEqual([90, 2, 2, 1]);
  });
});
