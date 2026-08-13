import {
  DASHBOARD_SCHEMA_VERSION,
  type DashboardProvider,
  type DashboardSnapshot,
  type JsonValue
} from "@usageatlas/contracts";
import type { EngineRequest, EngineResponse } from "./protocol";
import { ProviderError, type ProviderAdapter } from "./provider";
import { DESKTOP_VERSION } from "../shared/version";

const STALE_AFTER_SECONDS = 180;
const PROVIDER_REFRESH_TIMEOUT_MS = 60_000;

export class EngineService {
  private readonly providers = new Map<string, ProviderAdapter>();
  private readonly enabled = new Map<string, boolean>();
  private readonly explicitlyConfigured = new Set<string>();
  private readonly cached = new Map<string, DashboardProvider>();
  private readonly refreshedAt = new Map<string, number>();

  constructor(
    adapters: ProviderAdapter[],
    private readonly now: () => Date = () => new Date()
  ) {
    for (const adapter of adapters) {
      if (this.providers.has(adapter.id)) throw new Error(`Duplicate provider adapter: ${adapter.id}`);
      this.providers.set(adapter.id, adapter);
    }
  }

  async handle(request: EngineRequest): Promise<EngineResponse> {
    try {
      const result = await this.dispatch(request);
      return { id: request.id, ok: true, result, error: null };
    } catch (error) {
      const known = error instanceof ProviderError ? error : new ProviderError(
        "engine_error",
        error instanceof Error ? error.message : "Engine operation failed.",
        true
      );
      return {
        id: request.id,
        ok: false,
        result: null,
        error: { code: known.code, message: known.message, retryable: known.retryable }
      };
    }
  }

  private async dispatch(request: EngineRequest): Promise<JsonValue> {
    switch (request.method) {
      case "snapshot.get":
        await this.refreshAvailable(request.params.force === true);
        return this.snapshot() as unknown as JsonValue;
      case "provider.refresh": {
        const providerID = this.providerID(request.params.providerID);
        await this.refreshProvider(providerID);
        return this.snapshot() as unknown as JsonValue;
      }
      case "config.update": {
        const providerID = this.providerID(request.params.provider);
        if (typeof request.params.enabled !== "boolean") {
          throw new ProviderError("invalid_params", "enabled must be a boolean.");
        }
        this.enabled.set(providerID, request.params.enabled);
        this.explicitlyConfigured.add(providerID);
        return { provider: providerID, enabled: request.params.enabled };
      }
      case "shutdown":
        return { shuttingDown: true };
    }
  }

  private providerID(value: JsonValue | undefined): string {
    if (typeof value !== "string" || !this.providers.has(value)) {
      throw new ProviderError("unknown_provider", "Provider is not supported.");
    }
    return value;
  }

  private async refreshAvailable(force: boolean): Promise<void> {
    const now = this.now().valueOf();
    const providers = await Promise.all([...this.providers.values()].map(async (provider) => {
      if (this.explicitlyConfigured.has(provider.id) || !provider.isAvailable) return provider;
      const available = await provider.isAvailable().catch(() => false);
      this.enabled.set(provider.id, available);
      return provider;
    }));
    const refreshes = providers
      .filter((provider) => (this.enabled.get(provider.id) ?? true)
        && (force || !this.cached.has(provider.id)
          || now - (this.refreshedAt.get(provider.id) ?? 0) >= STALE_AFTER_SECONDS * 1_000))
      .map((provider) => this.refreshProvider(provider.id));
    await Promise.all(refreshes);
  }

  private async refreshProvider(providerID: string): Promise<void> {
    const adapter = this.providers.get(providerID);
    if (!adapter) throw new ProviderError("unknown_provider", "Provider is not supported.");
    const now = this.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_REFRESH_TIMEOUT_MS);
    try {
      const provider = await adapter.refresh({ signal: controller.signal, now });
      this.cached.set(providerID, {
        ...provider,
        id: adapter.id,
        name: adapter.name,
        enabled: this.enabled.get(providerID) ?? true
      });
    } catch (error) {
      const known = error instanceof ProviderError ? error : new ProviderError(
        error instanceof DOMException && error.name === "AbortError" ? "timeout" : "refresh_failed",
        error instanceof Error ? error.message : "Provider refresh failed.",
        true
      );
      this.cached.set(providerID, {
        id: adapter.id,
        name: adapter.name,
        enabled: this.enabled.get(providerID) ?? true,
        source: "unavailable",
        windows: [],
        identity: null,
        credits: null,
        analytics: null,
        error: { code: known.code, message: known.message, retryable: known.retryable },
        updatedAt: null
      });
    } finally {
      clearTimeout(timeout);
      this.refreshedAt.set(providerID, now.valueOf());
    }
  }

  private snapshot(): DashboardSnapshot {
    return {
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      generatedAt: this.now().toISOString(),
      staleAfterSeconds: STALE_AFTER_SECONDS,
      host: {
        engine: "typescript",
        version: DESKTOP_VERSION,
        platform: process.platform,
        architecture: process.arch
      },
      providers: [...this.providers.values()].map((adapter) => {
        const enabled = this.enabled.get(adapter.id) ?? true;
        const cached = this.cached.get(adapter.id);
        return cached
          ? { ...cached, enabled }
          : {
              id: adapter.id,
              name: adapter.name,
              enabled,
              source: "unavailable",
              windows: [],
              identity: null,
              credits: null,
              analytics: null,
              error: {
                code: enabled ? "provider_not_refreshed" : "provider_disabled",
                message: enabled ? "Provider has not been refreshed." : "Provider is disabled.",
                retryable: enabled
              },
              updatedAt: null
            };
      })
    };
  }
}
