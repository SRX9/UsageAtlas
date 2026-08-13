import type { ProviderAdapter } from "../engine/provider";
import { EngineService } from "../engine/engine-service";
import type { EngineRequest } from "../engine/protocol";
import { describe, expect, it } from "vitest";
import type { EngineTransport, EngineTransportHandlers } from "./engine-transport";
import { EngineManager } from "./engine-manager";

class InProcessTransport implements EngineTransport {
  private handlers: EngineTransportHandlers | null = null;

  constructor(private readonly service: EngineService) {}

  async start(handlers: EngineTransportHandlers): Promise<void> {
    this.handlers = handlers;
  }

  send(request: EngineRequest): void {
    void this.service.handle(request).then((response) => {
      this.handlers?.message(response);
      if (request.method === "shutdown") this.handlers?.exit(0);
    });
  }

  kill(): void {}
}

const adapter: ProviderAdapter = {
  id: "codex",
  name: "Codex",
  refresh: async ({ now }) => ({
    source: "fixture",
    windows: [],
    identity: null,
    credits: null,
    analytics: null,
    error: null,
    updatedAt: now.toISOString()
  })
};

describe("EngineManager", () => {
  it("uses the TypeScript transport and persists provider enablement", async () => {
    const service = new EngineService([adapter], () => new Date("2026-07-18T00:00:00Z"));
    const manager = new EngineManager(() => new InProcessTransport(service));
    await manager.applyProviderPreferences({ codex: false });
    expect((await manager.getSnapshot()).providers[0]?.enabled).toBe(false);
    expect((await manager.setProviderEnabled("codex", true)).providers[0]?.enabled).toBe(true);
    await manager.shutdown();
    expect(manager.getDiagnostics().status).toBe("stopped");
  });
});
