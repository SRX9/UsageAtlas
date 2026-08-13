import type { DashboardSnapshot, JsonValue } from "@usageatlas/contracts";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { EngineMethod, EngineResponse } from "../engine/protocol";
import { redactDiagnostic } from "../engine/platform/redaction";
import type { EngineDiagnostics, EngineStatus } from "../shared/desktop-api";
import { validateDashboard } from "./dashboard-validation";
import type { EngineTransport, EngineTransportFactory } from "./engine-transport";

interface PendingRequest {
  resolve(value: JsonValue): void;
  reject(reason: Error): void;
  timeout: NodeJS.Timeout;
}

export class EngineManager {
  private readonly events = new EventEmitter();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly diagnostics: string[] = [];
  private transport: EngineTransport | null = null;
  private starting: Promise<void> | null = null;
  private state: EngineStatus = "stopped";
  private restartCount = 0;
  private shuttingDown = false;

  constructor(private readonly createTransport: EngineTransportFactory) {}

  onStatus(listener: (status: EngineStatus) => void): () => void {
    this.events.on("status", listener);
    return () => this.events.off("status", listener);
  }

  async getSnapshot(): Promise<DashboardSnapshot> {
    return validateDashboard(await this.request("snapshot.get", { force: false }));
  }

  async refreshAll(): Promise<DashboardSnapshot> {
    return validateDashboard(await this.request("snapshot.get", { force: true }));
  }

  private async refreshProvider(providerID: string): Promise<DashboardSnapshot> {
    return validateDashboard(await this.request("provider.refresh", { providerID }));
  }

  async updateConfig(values: Record<string, JsonValue>): Promise<JsonValue> {
    return this.request("config.update", values);
  }

  async setProviderEnabled(providerID: string, enabled: boolean): Promise<DashboardSnapshot> {
    await this.updateConfig({ provider: providerID, enabled });
    return enabled ? this.refreshProvider(providerID) : this.getSnapshot();
  }

  async applyProviderPreferences(values: Record<string, boolean>): Promise<void> {
    for (const [providerID, enabled] of Object.entries(values)) {
      if (!/^[a-z0-9-]{1,64}$/u.test(providerID)) continue;
      try {
        await this.updateConfig({ provider: providerID, enabled });
      } catch {
        this.record(`Ignored an unsupported stored provider preference: ${providerID}`);
      }
    }
  }

  getDiagnostics(): EngineDiagnostics {
    return {
      status: this.state,
      restartCount: this.restartCount,
      messages: [...this.diagnostics]
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (!this.transport) {
      this.setStatus("stopped");
      return;
    }
    try {
      await this.request("shutdown", {}, 2_000);
    } catch (error) {
      this.record(error instanceof Error ? error.message : "Engine shutdown failed");
    } finally {
      this.transport?.kill();
      this.transport = null;
      this.setStatus("stopped");
    }
  }

  private async request(
    method: EngineMethod,
    params: Record<string, JsonValue>,
    timeoutMs = 70_000
  ): Promise<JsonValue> {
    await this.ensureStarted();
    const transport = this.transport;
    if (!transport) throw new Error("Engine utility process is unavailable");
    const id = randomUUID();
    return new Promise<JsonValue>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Engine request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        transport.send({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.transport) return;
    if (this.starting) return this.starting;
    this.setStatus("starting");
    const transport = this.createTransport();
    this.starting = transport.start({
      message: (response) => this.acceptResponse(response),
      diagnostic: (message) => this.record(message),
      exit: (code) => this.handleExit(transport, code)
    }).then(() => {
      this.transport = transport;
      this.record("TypeScript utility engine ready");
      this.setStatus("ready");
    }).catch((error: unknown) => {
      transport.kill();
      this.record(error instanceof Error ? error.message : "Engine startup failed");
      this.setStatus("degraded");
      throw error;
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private acceptResponse(response: EngineResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      this.record(`Ignored response for unknown request ${response.id}`);
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(`${response.error.code}: ${response.error.message}`));
  }

  private handleExit(transport: EngineTransport, code: number): void {
    if (this.transport !== transport && this.starting === null) return;
    if (this.transport === transport) this.transport = null;
    this.rejectPending(new Error(`Engine utility process exited (${code})`));
    if (this.shuttingDown) {
      this.setStatus("stopped");
      return;
    }
    this.setStatus("degraded");
    if (this.restartCount >= 3) return;
    const delay = 250 * 2 ** this.restartCount;
    this.restartCount += 1;
    setTimeout(() => void this.ensureStarted().catch(() => undefined), delay);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }

  private setStatus(status: EngineStatus): void {
    if (this.state === status) return;
    this.state = status;
    this.events.emit("status", status);
  }

  private record(message: string): void {
    this.diagnostics.push(redactDiagnostic(message));
    if (this.diagnostics.length > 50) this.diagnostics.shift();
  }
}
