import cursorFixture from "@usageatlas/contracts/fixtures/providers/cursor-usage-summary.json";
import type { DashboardSnapshot, JsonValue } from "@usageatlas/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateDashboard } from "../main/dashboard-validation";
import { buildAnalytics, unavailableAnalytics } from "./analytics/local-usage";
import { EngineService } from "./engine-service";
import { SqliteHistoryStore } from "./history/sqlite-store";
import { UsageSync } from "./history/usage-sync";
import type { ProviderAdapter } from "./provider";
import { parseCursorUsage } from "./providers/cursor";

const now = new Date("2026-09-10T12:00:00Z");
const stores: SqliteHistoryStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.unstubAllGlobals(); });

function setup() {
  const store = SqliteHistoryStore.open(":memory:");
  stores.push(store);
  store.usage.selectAccount("old-account");
  const lookbacks: number[] = [];
  const refresh = vi.fn<ProviderAdapter["refresh"]>(async context => {
    const days = context.historyDaysForAccount("cursor-user");
    lookbacks.push(days);
    const dates = days > 1 ? ["2026-09-09", "2026-09-10"] : ["2026-09-10"];
    const records = dates.map(day => ({
      day, eventKey: day, timestamp: `${day}T10:00:00Z`, model: "gpt-5", sessionID: day,
      projectPath: null, projectLabel: "Unknown project", serviceTier: "standard",
      inputTokens: 100, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 10,
      totalTokens: 110, estimatedCostUSD: 0.1
    }));
    return { ...parseCursorUsage(cursorFixture, now), accountKey: "cursor-user",
      analytics: buildAnalytics(records, now, days, 1, false, "remote_usage") };
  });
  const changed = vi.fn();
  const engine = new EngineService([{ id: "cursor", name: "Cursor", isAvailable: async () => true, refresh }], () => now, store, undefined, changed);
  let id = 0;
  const configure = async (accountId: string) => {
    const response = await engine.handle({ id: String(++id), method: "cloud", params: {
      operation: "configure", accountId, token: "", baseURL: "https://usageatlas.example"
    } });
    expect(response.ok).toBe(true);
  };
  const read = async (params: Record<string, JsonValue>): Promise<DashboardSnapshot> => {
    const response = await engine.handle({ id: String(++id), method: "snapshot.get", params });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    return validateDashboard(response.result);
  };
  return { store, engine, refresh, configure, read, lookbacks, changed };
}

describe("account transitions with SQLite history", () => {
  it("isolates recreated accounts, preserves old history, and backfills only the new account", async () => {
    const { store, refresh, configure, read, lookbacks } = setup();
    const original = await read({ force: true });
    await store.imports.wait("old-account", new AbortController().signal);
    const oldRows = store.usage.records();
    expect(original.providers[0]?.analytics?.totals.totalTokens).toBe(220);
    await configure("new-account");
    const pending = await read({ hydrateOnly: true });
    expect(pending.providers[0]?.analytics).toBeNull();
    expect(pending.providers[0]?.error?.code).toBe("provider_not_refreshed");
    expect(store.usage.records()).toEqual([]);
    expect(oldRows.every(row => store.usage.get(row.record.recordId, "old-account") !== null)).toBe(true);
    const current = await read({ force: false });
    expect(current.providers[0]?.analytics?.totals.totalTokens).toBe(220);
    expect(store.usage.records()).toHaveLength(oldRows.length);
    await configure("old-account");
    expect((await read({ hydrateOnly: true })).providers[0]?.analytics?.totals.totalTokens).toBe(220);
    await read({ force: false });
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(lookbacks).toEqual([90, 90, 1]);
  });

  it("retains a fresh cache across same-account credential configuration", async () => {
    const { read, configure, refresh } = setup();
    await read({ force: false });
    await configure("old-account");
    await read({ force: false });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("respects explicit provider disablement through account changes", async () => {
    const { engine, read, configure, refresh } = setup();
    await read({ force: true });
    await engine.handle({ id: "disable", method: "config.update", params: { provider: "cursor", enabled: false } });
    await configure("new-account");
    const current = await read({ force: false });
    expect(current.providers[0]).toMatchObject({ enabled: false, error: { code: "provider_disabled" } });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("preserves local records when an empty cloud account is restored", async () => {
    const { store, read } = setup();
    await read({ force: true });
    const before = store.usage.records();
    const sync = new UsageSync(store.usage);
    try {
      await sync.configure("old-account", { read: async () => ({ records: [], next: null }), save: async () => [] });
      await sync.restore();
      expect(store.usage.records()).toEqual(before);
    } finally { sync.close(); }
  });

  it("retries the full initial backfill after a failed first download", async () => {
    const { store, read, refresh, lookbacks } = setup();
    const successfulRefresh = refresh.getMockImplementation()!;
    refresh.mockResolvedValueOnce({ ...parseCursorUsage(cursorFixture, now), accountKey: "cursor-user",
      analytics: unavailableAnalytics(now, 90, { code: "timeout", message: "History timed out.", retryable: true }, "remote_usage") });
    const first = await read({ force: true });
    expect(first.providers[0]?.analytics?.status).toBe("unavailable");
    expect(store.getRange("cursor", "2026-06-13", "2026-09-10")).toEqual([]);
    refresh.mockImplementation(successfulRefresh);
    expect((await read({ force: true })).providers[0]?.analytics?.totals.totalTokens).toBe(220);
    expect(lookbacks).toEqual([90]);
  });

  it("keeps saved usage and leaves missing history unsealed after a failed Cursor download", async () => {
    const { store, engine, read, refresh, changed } = setup();
    await read({ force: true });
    const before = store.getRange("cursor", "2026-09-09", "2026-09-10");
    const successfulRefresh = refresh.getMockImplementation()!;
    refresh.mockResolvedValue({ ...parseCursorUsage(cursorFixture, now), accountKey: "cursor-user",
      analytics: unavailableAnalytics(now, 90, { code: "timeout", message: "History timed out.", retryable: true }, "remote_usage") });
    const current = await read({ force: true });
    expect(current.providers[0]?.windows).toEqual(parseCursorUsage(cursorFixture, now).windows);
    expect(current.providers[0]?.analytics?.totals.totalTokens).toBe(220);
    expect(store.getRange("cursor", "2026-09-09", "2026-09-10").map(row => row.payload.totals))
      .toEqual(before.map(row => row.payload.totals));
    expect(store.get("cursor", "cursor-user", "2026-09-08")).toBeNull();
    expect(current.providers[0]?.analytics).toMatchObject({ status: "partial", error: { code: "timeout" } });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ records: [], next: null })));
    await engine.handle({ id: "connect", method: "cloud", params: { operation: "configure", accountId: "old-account", token: "fixture", baseURL: "https://usageatlas.example" } });
    await engine.handle({ id: "restore", method: "cloud", params: { operation: "restore" } });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect((await read({ hydrateOnly: true })).providers[0]?.analytics).toMatchObject({ status: "partial", error: { code: "timeout" } });
    refresh.mockImplementation(successfulRefresh);
    expect((await read({ force: true })).providers[0]?.analytics).toMatchObject({ status: "available", error: null });
  });
});
