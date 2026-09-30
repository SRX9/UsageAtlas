import { describe, expect, it } from "vitest";
import type { DashboardSnapshot } from "@usageatlas/contracts";
import { validateUsageFact } from "@usageatlas/contracts/statistics";
import { validateUsageRecord } from "@usageatlas/contracts/usage";
import { validateDashboard } from "../../main/dashboard-validation";
import { EngineService } from "../engine-service";
import { ProviderError } from "../provider";
import { SqliteHistoryStore } from "../history";
import { quotaAdapter, quotaJson, reading, metric } from "./quota-shared";
const now = new Date("2026-09-28T00:00:00Z");
const context = { now, signal: new AbortController().signal, historyDays: 30, historyDaysForAccount: () => 30 };

describe("quota collection through storage and restore", () => {
  it.each(["warp", "kimi", "kilo", "copilot", "factory", "amp", "qoder"] as const)("persists %s capacity, with no fabricated historical usage", async id => {
    const store = SqliteHistoryStore.open(":memory:");
    const restored = SqliteHistoryStore.open(":memory:");
    try {
      const adapter = quotaAdapter(id, async () => reading(id, [metric("balance", "Credit balance", "USD", null, null, 12.34), metric("core_weekly", "Core weekly", "percent", 25, 100)]), { environment: {} });
      adapter.configureCredential!({ secret: "do-not-persist-this" });
      const engine = new EngineService([adapter], () => now, store);
      const reply = await engine.handle({ id: "refresh", method: "snapshot.get", params: { force: true } });
      expect(reply.ok).toBe(true);
      const snapshot = validateDashboard(reply.result!);
      expect(snapshot.providers[0].analytics).toBeNull();
      expect(snapshot.providers[0].quotaMetrics).toHaveLength(2);
      const facts = store.usage.statistics.pending();
      expect(facts).toHaveLength(1); expect(facts[0].kind).toBe("capacity"); expect(() => validateUsageFact(facts[0])).not.toThrow();
      const records = store.usage.records();
      expect(records.map(r => r.record.kind)).toEqual(["capacity_snapshot"]);
      expect(JSON.stringify(records)).not.toContain("do-not-persist-this"); expect(JSON.stringify(facts)).not.toContain("do-not-persist-this");
      for (const row of records) { validateUsageRecord(row.record); restored.usage.put(row.record); }
      const capacity = restored.latestCapacity(id)!;
      expect(capacity.payload.quotaMetrics).toEqual(snapshot.providers[0].quotaMetrics);
      expect(capacity.payload.windows).toEqual(snapshot.providers[0].windows);
      const hydrated = await new EngineService([adapter], () => now, restored).handle({ id: "hydrate", method: "snapshot.get", params: { hydrateOnly: true } });
      expect(validateDashboard(hydrated.result!).providers[0].quotaMetrics).toHaveLength(2);
    } finally { await store.close(); await restored.close(); }
  });
  it("clears removed windows after a successful unlimited/balance-only response", async () => {
    let limit: number | null = 100;
    const adapter = quotaAdapter("copilot", async () => reading("Copilot", [metric("seat_credits", "Seat credits", "credits", 31, limit)]), { environment: { COPILOT_GITHUB_TOKEN: "key" } });
    const engine = new EngineService([adapter], () => now);
    await engine.handle({ id: "first", method: "snapshot.get", params: { force: true } });
    limit = null;
    const reply = await engine.handle({ id: "second", method: "snapshot.get", params: { force: true } });
    expect(validateDashboard(reply.result!).providers[0].windows).toEqual([]);
  });
  it("does not expose previous account counters after credentials change", async () => {
    const adapter = quotaAdapter("warp", async () => reading("Warp", [metric("plan", "Credits", "credits", 40, 100)]), { environment: { WARP_API_KEY: "old" } });
    const engine = new EngineService([adapter], () => now);
    await engine.handle({ id: "first", method: "snapshot.get", params: { force: true } });
    expect((await engine.handle({ id: "config", method: "config.update", params: { provider: "warp", credential: { secret: "new" } } })).ok).toBe(true);
    const reply = await engine.handle({ id: "hydrate", method: "snapshot.get", params: { hydrateOnly: true } });
    const provider = (reply.result as unknown as DashboardSnapshot).providers[0];
    expect(provider.windows).toEqual([]); expect(provider.quotaMetrics).toEqual([]);
    expect(provider.error?.code).toBe("provider_not_refreshed");
  });
  it("does not restore a different account's persisted limits when the new credential fails", async () => {
    const store = SqliteHistoryStore.open(":memory:");
    try {
      const adapter = quotaAdapter("warp", async credential => {
        if (credential.secret === "new") throw new ProviderError("auth_required", "Credential rejected.");
        return reading("Warp", [metric("plan", "Credits", "credits", 40, 100)], "Old plan");
      }, { environment: { WARP_API_KEY: "old" } });
      const engine = new EngineService([adapter], () => now, store);
      await engine.handle({ id: "first", method: "snapshot.get", params: { force: true } });
      expect(store.latestCapacity("warp")?.payload.windows).toHaveLength(1);
      await engine.handle({ id: "config", method: "config.update", params: { provider: "warp", credential: { secret: "new" } } });
      const reply = await engine.handle({ id: "failed", method: "snapshot.get", params: { force: true } });
      const provider = validateDashboard(reply.result!).providers[0];
      expect(provider.error?.code).toBe("auth_required");
      expect(provider.windows).toEqual([]); expect(provider.quotaMetrics).toEqual([]);
      expect(provider.identity).toBeNull(); expect(provider.updatedAt).toBeNull();
      // Both cloud account changes and history restore invalidate the engine cache.
      await engine.handle({ id: "cloud", method: "cloud", params: { operation: "configure", accountId: "signed-in", token: "", baseURL: "https://example.test" } });
      const hydrated = await engine.handle({ id: "hydrate", method: "snapshot.get", params: { hydrateOnly: true } });
      expect(validateDashboard(hydrated.result!).providers[0]).toMatchObject({ windows: [], identity: null, updatedAt: null });
      const retried = await engine.handle({ id: "retry", method: "snapshot.get", params: { force: true } });
      expect(validateDashboard(retried.result!).providers[0]).toMatchObject({ windows: [], quotaMetrics: [], identity: null, error: { code: "auth_required" } });
    } finally { await store.close(); }
  });
  it("restores only the selected credential's capacity across restart and environment changes", async () => {
    const store = SqliteHistoryStore.open(":memory:");
    const environment = { WARP_API_KEY: "first" };
    let offline = false;
    const adapter = quotaAdapter("warp", async credential => {
      if (offline) throw new ProviderError("network_error", "Offline.", true);
      return reading("Warp", [metric("plan", "Credits", "credits", credential.secret === "first" ? 40 : 80, 100)]);
    }, { environment });
    const first = new EngineService([adapter], () => now, store);
    try {
      await first.handle({ id: "first", method: "snapshot.get", params: { force: true } });
      environment.WARP_API_KEY = "second";
      await first.handle({ id: "second", method: "snapshot.get", params: { force: true } });
      offline = true;
      environment.WARP_API_KEY = "first";
      const restarted = new EngineService([adapter], () => now, store);
      const hydrate = await restarted.handle({ id: "hydrate", method: "snapshot.get", params: { hydrateOnly: true } });
      expect(validateDashboard(hydrate.result!).providers[0].quotaMetrics?.[0].used).toBe(40);
      const failed = await restarted.handle({ id: "failed", method: "snapshot.get", params: { force: true } });
      expect(validateDashboard(failed.result!).providers[0]).toMatchObject({ quotaMetrics: [{ used: 40 }], error: { code: "network_error" } });
      environment.WARP_API_KEY = "never-seen";
      const other = await restarted.handle({ id: "other", method: "snapshot.get", params: { force: true } });
      expect(validateDashboard(other.result!).providers[0]).toMatchObject({ windows: [], quotaMetrics: [], identity: null });
      environment.WARP_API_KEY = "";
      const missing = await new EngineService([adapter], () => now, store).handle({ id: "missing", method: "snapshot.get", params: { hydrateOnly: true } });
      expect(validateDashboard(missing.result!).providers[0].windows).toEqual([]);
    } finally { await store.close(); }
  });
  it("keeps a balance-only snapshot intact during an outage", async () => {
    const store = SqliteHistoryStore.open(":memory:");
    let calls = 0;
    try {
      const adapter = quotaAdapter("kilo", async () => {
        if (++calls === 3) throw new ProviderError("network_error", "Unavailable.", true);
        return reading("Kilo", [calls === 1 ? metric("old", "Expired pool", "USD", 5, 10) : metric("balance", "Balance", "USD", null, null, 8)]);
      }, { environment: { KILO_API_KEY: "key" } });
      const engine = new EngineService([adapter], () => now, store);
      for (let i = 0; i < 2; i++) await engine.handle({ id: String(i), method: "snapshot.get", params: { force: true } });
      const reply = await engine.handle({ id: "failed", method: "snapshot.get", params: { force: true } });
      const provider = validateDashboard(reply.result!).providers[0];
      expect(provider.error?.code).toBe("network_error");
      expect(provider.windows).toEqual([]);
      expect(provider.quotaMetrics).toEqual([metric("balance", "Balance", "USD", null, null, 8)]);
    } finally { await store.close(); }
  });
});
describe("bounded quota transport", () => {
  it("rejects duplicate or excessive pools before they can corrupt saved capacity", () => {
    const m = metric("plan", "Allowance", "credits", 1, 10);
    expect(() => reading("Tool", [m, m])).toThrow();
    expect(() => reading("Tool", Array.from({ length: 17 }, (_, i) => metric(`pool_${i}`, "Pool", "credits", 1, 10)))).toThrow();
  });
  it("classifies throttling without echoing sensitive response bodies", async () => {
    await expect(quotaJson("Tool", "https://example.test", context, { fetch: async () => new Response("secret", { status: 429 }) })).rejects.toMatchObject({ code: "http_429", retryable: true });
  });
  it("rejects oversized chunked bodies and cancels reading", async () => {
    let cancelled = false;
    const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(600_000)); }, cancel() { cancelled = true; } });
    await expect(quotaJson("Tool", "https://example.test", context, { fetch: async () => new Response(stream) })).rejects.toMatchObject({ code: "invalid_response" });
    expect(cancelled).toBe(true);
  });
  it("propagates cancellation and rejects malformed JSON", async () => {
    const c = new AbortController(); c.abort();
    await expect(quotaJson("Tool", "https://example.test", { ...context, signal: c.signal }, { fetch: async (_url, init) => {
      init?.signal?.throwIfAborted(); throw new Error("unreachable");
    } })).rejects.toMatchObject({ code: "timeout" });
    await expect(quotaJson("Tool", "https://example.test", context, { fetch: async () => new Response("<html>secret</html>") })).rejects.toThrow("invalid usage response");
  });
});
