import dashboardFixture from "@usageatlas/contracts/fixtures/dashboard-v2.json";
import type { JsonValue } from "@usageatlas/contracts";
import type { ProviderAdapter } from "./provider";
import { describe, expect, it, vi } from "vitest";
import { validateDashboard } from "../main/dashboard-validation";
import { EngineService } from "./engine-service";

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
});
