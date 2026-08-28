import dashboardFixture from "@usageatlas/contracts/fixtures/dashboard-v2.json";
import {
  HISTORY_DAY_PAYLOAD_VERSION,
  HISTORY_LOCAL_ACCOUNT_KEY,
  type HistoryDayPayload,
  type JsonValue,
  type UsageTotals
} from "@usageatlas/contracts";
import type { ProviderAdapter } from "./provider";
import { describe, expect, it, vi } from "vitest";
import { validateDashboard } from "../main/dashboard-validation";
import { EngineService } from "./engine-service";
import { MemoryHistoryStore } from "./history";
import type { EngineRefreshProgress } from "./protocol";

const now = new Date("2026-07-18T00:00:00.000Z");

function adapter(): ProviderAdapter {
  return {
    id: "fixture",
    name: "Fixture",
    refresh: vi.fn(async () => ({
      source: "fixture",
      windows: [{ kind: "session", label: "Session", usedPercent: 25, remainingPercent: 75 }],
      identity: { plan: "test" },
      credits: null,
      analytics: null,
      error: null,
      updatedAt: now.toISOString()
    }))
  };
}

describe("EngineService", () => {
  it("validates the complete analytics contract fixture", () => {
    const snapshot = validateDashboard(dashboardFixture as unknown as JsonValue);
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.providers[0]?.analytics?.totals.totalTokens).toBe(1_800);
  });

  it("validates provider-reported remote analytics", () => {
    const fixture = structuredClone(dashboardFixture);
    const analytics = fixture.providers[0]?.analytics;
    if (!analytics) throw new Error("Analytics fixture is missing.");
    analytics.source = "remote_usage";
    expect(validateDashboard(fixture as unknown as JsonValue).providers[0]?.analytics?.source)
      .toBe("remote_usage");
  });

  it("refreshes registered providers and emits a valid dashboard", async () => {
    const provider = adapter();
    const engine = new EngineService([provider], () => now);
    const response = await engine.handle({ id: "1", method: "snapshot.get", params: { force: true } });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const snapshot = validateDashboard(response.result);
    expect(snapshot.host.engine).toBe("typescript");
    expect(snapshot.providers).toHaveLength(1);
    expect(snapshot.providers[0]?.windows[0]?.usedPercent).toBe(25);
    expect(provider.refresh).toHaveBeenCalledOnce();
  });

  it("persists provider enablement without refreshing disabled providers", async () => {
    const provider = adapter();
    const engine = new EngineService([provider], () => now);
    await engine.handle({ id: "1", method: "config.update", params: { provider: "fixture", enabled: false } });
    const response = await engine.handle({ id: "2", method: "snapshot.get", params: { force: true } });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const snapshot = validateDashboard(response.result);
    expect(snapshot.providers[0]?.enabled).toBe(false);
    expect(snapshot.providers[0]?.error?.code).toBe("provider_disabled");
    expect(provider.refresh).not.toHaveBeenCalled();
  });

  it("keeps an automatically discovered provider disabled when its local app is absent", async () => {
    let available = false;
    const provider = { ...adapter(), isAvailable: vi.fn(async () => available) };
    const engine = new EngineService([provider], () => now);
    const first = await engine.handle({ id: "1", method: "snapshot.get", params: { force: true } });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const snapshot = validateDashboard(first.result);
    expect(snapshot.providers[0]?.enabled).toBe(false);
    expect(snapshot.providers[0]?.error?.code).toBe("provider_disabled");
    expect(provider.refresh).not.toHaveBeenCalled();

    available = true;
    const second = await engine.handle({ id: "2", method: "snapshot.get", params: { force: true } });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(validateDashboard(second.result).providers[0]?.enabled).toBe(true);
    expect(provider.refresh).toHaveBeenCalledOnce();
  });

  it("rejects unknown providers", async () => {
    const engine = new EngineService([adapter()], () => now);
    const response = await engine.handle({
      id: "1",
      method: "provider.refresh",
      params: { providerID: "missing" }
    });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("unknown_provider");
  });

  it("paints from saved history without calling providers", async () => {
    const localNow = new Date(2026, 6, 18, 12);
    const store = new MemoryHistoryStore();
    store.sealDay("fixture", HISTORY_LOCAL_ACCOUNT_KEY, "2026-07-17", historyPayload(tokens(40)));
    const provider = adapter();
    const engine = new EngineService([provider], () => localNow, store);
    const response = await engine.handle({
      id: "1",
      method: "snapshot.get",
      params: { hydrateOnly: true }
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const snapshot = validateDashboard(response.result);
    expect(provider.refresh).not.toHaveBeenCalled();
    expect(snapshot.providers[0]?.analytics?.daily.some((day) => day.totalTokens === 40)).toBe(true);
  });

  it("only looks back one day after local history is already sealed", async () => {
    const localNow = new Date(2026, 6, 18, 12);
    const store = new MemoryHistoryStore();
    store.sealDay("fixture", HISTORY_LOCAL_ACCOUNT_KEY, "2026-07-17", historyPayload(tokens(40)));
    const refresh = vi.fn(async () => ({
      source: "fixture",
      windows: [{ kind: "session", label: "Session", usedPercent: 25, remainingPercent: 75 }],
      identity: { plan: "test" },
      credits: null,
      analytics: null,
      error: null,
      updatedAt: localNow.toISOString()
    }));
    const provider: ProviderAdapter = { id: "fixture", name: "Fixture", refresh };
    const engine = new EngineService([provider], () => localNow, store);
    await engine.handle({ id: "1", method: "snapshot.get", params: { hydrateOnly: true } });
    await engine.handle({ id: "2", method: "snapshot.get", params: { force: false } });
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh.mock.calls[0]?.[0].historyDays).toBe(1);
  });

  it("reports refresh progress for each provider", async () => {
    const events: EngineRefreshProgress[] = [];
    const provider = adapter();
    const engine = new EngineService([provider], () => now, new MemoryHistoryStore(), (progress) => {
      events.push(progress);
    });
    await engine.handle({ id: "1", method: "snapshot.get", params: { force: true } });
    expect(events[0]).toMatchObject({ completed: 0, total: 1, status: "started" });
    expect(events.some((event) => event.providerName === "Fixture" && event.status === "completed")).toBe(true);
  });
});

function tokens(totalTokens: number): UsageTotals {
  return {
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    totalTokens,
    requests: totalTokens > 0 ? 1 : 0,
    estimatedCostUSD: null,
    unpricedTokens: 0
  };
}

function historyPayload(totals: UsageTotals): HistoryDayPayload {
  return {
    payloadVersion: HISTORY_DAY_PAYLOAD_VERSION,
    accountKey: HISTORY_LOCAL_ACCOUNT_KEY,
    windows: [{ kind: "session", label: "Session", usedPercent: 10, remainingPercent: 90 }],
    identity: { plan: "test" },
    credits: null,
    source: "fixture",
    capturedAt: now.toISOString(),
    status: "available",
    analyticsSource: "local_sessions",
    totals,
    hourly: [],
    models: [],
    projects: [],
    sessions: [],
    serviceTiers: [],
    filesScanned: 1,
    recordsProcessed: 1,
    error: null
  };
}
