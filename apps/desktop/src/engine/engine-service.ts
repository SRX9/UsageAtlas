import type { LocalImportProgress } from "../shared/desktop-api";
import { SqliteHistoryStore } from "./history/sqlite-store";
import { UsageSync, httpUsageCloud } from "./history/usage-sync";
import {
  DASHBOARD_SCHEMA_VERSION,
  HISTORY_LOCAL_ACCOUNT_KEY,
  type DashboardProvider,
  type DashboardSnapshot,
  type DashboardWindow,
  type HistoryDayRecord,
  type JsonValue,
  type ProviderFailure
} from "@usageatlas/contracts";
import {
  HISTORY_BACKFILL_DAYS,
  HISTORY_SNAPSHOT_DAYS,
  composeFromStore,
  historyDaysForAccount,
  localCalendarDay,
  persistProviderHistory,
  resolveAccountKey,
  shiftLocalDay,
  type HistoryStore,
  MemoryHistoryStore
} from "./history";
import type { EngineRefreshProgress, EngineRequest, EngineResponse } from "./protocol";
import { ProviderError, type ProviderAdapter, type ProviderRefreshResult } from "./provider";
import { DESKTOP_VERSION } from "../shared/version";

const STALE_AFTER_SECONDS = 180;
const PROVIDER_REFRESH_TIMEOUT_MS = 60_000;

export class EngineService {
  private readonly providers = new Map<string, ProviderAdapter>();
  private readonly enabled = new Map<string, boolean>();
  private readonly explicitlyConfigured = new Set<string>();
  private readonly cached = new Map<string, DashboardProvider>();
  private readonly refreshedAt = new Map<string, number>();
  private readonly analyticsFailures = new Map<string, ProviderFailure>();
  private readonly history: HistoryStore;
  private readonly sync: UsageSync | null;

  constructor(
    adapters: ProviderAdapter[],
    private readonly now: () => Date = () => new Date(),
    history: HistoryStore = new MemoryHistoryStore(),
    private readonly emitProgress?: (progress: EngineRefreshProgress) => void,
    private readonly historyChanged?: () => void,
    private readonly importChanged?: (accountId: string, progress: LocalImportProgress | null) => void
  ) {
    this.history = history;
    this.sync = history instanceof SqliteHistoryStore ? new UsageSync(history.usage, (reason) => {
      this.cached.clear();
      if (reason === "account") {
        this.refreshedAt.clear();
        this.analyticsFailures.clear();
      }
      this.historyChanged?.();
    }, signal => history.imports.wait(history.usage.owner, signal)) : null;
    if (history instanceof SqliteHistoryStore)
      history.imports.onProgress = () => this.importChanged?.(history.usage.owner, history.imports.status());
    for (const adapter of adapters) {
      if (this.providers.has(adapter.id)) throw new Error(`Duplicate provider adapter: ${adapter.id}`);
      this.providers.set(adapter.id, adapter);
    }
  }

  async handle(request: EngineRequest): Promise<EngineResponse> {
    // Background writes must not spend another provider's scan timeout on disk I/O.
    const imports = this.history instanceof SqliteHistoryStore
      && (request.method === "snapshot.get" || request.method === "provider.refresh")
      ? this.history.imports : null;
    imports?.pause();
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
    } finally {
      imports?.resume();
    }
  }

  private async dispatch(request: EngineRequest): Promise<JsonValue> {
    switch (request.method) {
      case "snapshot.get":
        this.hydrateFromHistory();
        if (request.params.hydrateOnly === true) {
          return this.snapshot() as unknown as JsonValue;
        }
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
      case "cloud": {
        const { operation, accountId, token, baseURL, enabled, recordId, choice } = request.params;
        if (operation === "configure") {
          if (typeof accountId !== "string" || typeof token !== "string" || typeof baseURL !== "string") throw new Error("Invalid account configuration.");
          // Memory-only history contains no cloud records; keep local collection available.
          if (!this.sync) return null;
          await this.sync.configure(accountId, token ? httpUsageCloud(baseURL, token) : null);
          if (this.history instanceof SqliteHistoryStore)
            this.importChanged?.(this.history.usage.owner, this.history.imports.status());
          return this.sync.status() as unknown as JsonValue;
        }
        if (!this.sync) throw new Error("Cloud save requires local SQLite storage.");
        switch (operation) {
          case "status": break;
          case "automatic":
            if (typeof enabled !== "boolean") throw new Error("Invalid automatic save setting.");
            this.sync.setAutomatic(enabled);
            break;
          case "save": void this.sync.save().catch(() => undefined); break;
          case "restore": void this.sync.restore().catch(() => undefined); break;
          case "resolve":
            if (typeof recordId !== "string" || (choice !== "local" && choice !== "cloud")) throw new Error("Invalid conflict choice.");
            this.sync.resolve(recordId, choice);
            break;
          default: throw new Error("Unknown cloud operation.");
        }
        return this.sync.status() as unknown as JsonValue;
      }
      case "shutdown":
        this.sync?.close();
        await this.history.close?.();
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
      const cached = this.cached.get(provider.id);
      this.enabled.set(provider.id, available || Boolean(cached?.analytics || cached?.windows.length));
      return provider;
    }));
    const pending = providers.filter((provider) => (this.enabled.get(provider.id) ?? true)
      && (force || !this.cached.has(provider.id)
        || now - (this.refreshedAt.get(provider.id) ?? 0) >= STALE_AFTER_SECONDS * 1_000));
    if (pending.length === 0) return;
    this.emitProgress?.({
      completed: 0,
      total: pending.length,
      providerID: null,
      providerName: null,
      status: "started"
    });
    let completed = 0;
    await Promise.all(pending.map(async (provider) => {
      this.emitProgress?.({
        completed,
        total: pending.length,
        providerID: provider.id,
        providerName: provider.name,
        status: "started"
      });
      await this.refreshProvider(provider.id);
      completed += 1;
      this.emitProgress?.({
        completed,
        total: pending.length,
        providerID: provider.id,
        providerName: provider.name,
        status: "completed"
      });
    }));
  }

  private hydrateFromHistory(): void {
    const now = this.now();
    for (const adapter of this.providers.values()) {
      if (this.cached.has(adapter.id)) continue;
      const enabled = this.enabled.get(adapter.id) ?? true;
      if (!enabled && this.explicitlyConfigured.has(adapter.id)) continue;
      const fallback = fallbackFromHistory(this.history, adapter.id, now, HISTORY_LOCAL_ACCOUNT_KEY);
      if (!fallback.composed && !fallback.today && !fallback.capacity) continue;
      this.enabled.set(adapter.id, true);
      const capacity = firstCapacity(undefined, fallback.today, fallback.capacity);
      this.cached.set(adapter.id, {
        id: adapter.id,
        name: adapter.name,
        enabled: true,
        source: capacity?.source ?? "unavailable",
        windows: capacity?.windows ?? [],
        identity: capacity?.identity ?? null,
        credits: capacity?.credits ?? null,
        analytics: this.withAnalyticsFailure(adapter.id, fallback.composed),
        error: null,
        updatedAt: capacity?.updatedAt ?? null
      });
    }
  }

  private async refreshProvider(providerID: string): Promise<void> {
    const adapter = this.providers.get(providerID);
    if (!adapter) throw new ProviderError("unknown_provider", "Provider is not supported.");
    const now = this.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_REFRESH_TIMEOUT_MS);
    const defaultAccountKey = HISTORY_LOCAL_ACCOUNT_KEY;
    let reportingTimeZone = this.history.reportingTimeZone?.(providerID, defaultAccountKey);
    const lookbackDays = (accountKey: string): number => safeHistory(
      () => historyDaysForAccount(this.history, providerID, resolveAccountKey(accountKey), now),
      HISTORY_BACKFILL_DAYS,
      "lookback"
    );
    try {
      const refreshed = await adapter.refresh({
        signal: controller.signal,
        now,
        historyDays: lookbackDays(defaultAccountKey),
        historyDaysForAccount: lookbackDays,
        reportingTimeZoneForAccount: account => { reportingTimeZone = this.history.reportingTimeZone?.(providerID, account); return reportingTimeZone; }
      });
      const accountKey = resolveAccountKey(refreshed.accountKey);
      const { accountKey: _ignored, ...provider } = refreshed as ProviderRefreshResult & {
        accountKey?: string;
      };
      void _ignored;
      if (provider.analytics?.status === "unavailable" && provider.analytics.error)
        this.analyticsFailures.set(providerID, provider.analytics.error);
      else this.analyticsFailures.delete(providerID);
      const previous = this.cached.get(providerID);
      const persisted = persistLiveHistory(this.history, providerID, accountKey, now, provider, reportingTimeZone);
      if (provider.analytics) {
        const { collection: _collection, ...displayAnalytics } = provider.analytics;
        void _collection;
        provider.analytics = displayAnalytics;
      }
      this.cached.set(providerID, {
        ...provider,
        id: adapter.id,
        name: adapter.name,
        enabled: this.enabled.get(providerID) ?? true,
        windows: firstWindows(provider.windows, persisted.storedToday?.payload.windows, previous?.windows),
        identity: provider.identity ?? persisted.storedToday?.payload.identity ?? previous?.identity ?? null,
        credits: provider.credits ?? persisted.storedToday?.payload.credits ?? previous?.credits ?? null,
        analytics: this.withAnalyticsFailure(providerID, persisted.composed ?? provider.analytics)
      });
    } catch (error) {
      const known = error instanceof ProviderError ? error : new ProviderError(
        error instanceof DOMException && error.name === "AbortError" ? "timeout" : "refresh_failed",
        error instanceof Error ? error.message : "Provider refresh failed.",
        true
      );
      const previous = this.cached.get(providerID);
      const fallback = fallbackFromHistory(this.history, providerID, now, defaultAccountKey);
      const capacity = firstCapacity(previous, fallback.today, fallback.capacity);
      this.cached.set(providerID, {
        id: adapter.id,
        name: adapter.name,
        enabled: this.enabled.get(providerID) ?? true,
        source: capacity?.source ?? "unavailable",
        windows: capacity?.windows ?? [],
        identity: capacity?.identity ?? null,
        credits: capacity?.credits ?? null,
        analytics: fallback.composed ?? previous?.analytics ?? null,
        error: { code: known.code, message: known.message, retryable: known.retryable },
        updatedAt: capacity?.updatedAt ?? null
      });
    } finally {
      clearTimeout(timeout);
      this.refreshedAt.set(providerID, now.valueOf());
    }
  }

  private withAnalyticsFailure(
    providerID: string,
    analytics: DashboardProvider["analytics"]
  ): DashboardProvider["analytics"] {
    const error = this.analyticsFailures.get(providerID);
    if (analytics?.collection) {
      const { collection: _collection, ...display } = analytics;
      void _collection;
      analytics = display;
    }
    if (!analytics || !error) return analytics;
    return { ...analytics, status: analytics.daily.length > 0 ? "partial" : "unavailable", error };
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

function persistLiveHistory(
  history: HistoryStore,
  providerID: string,
  accountKey: string,
  now: Date,
  live: Omit<DashboardProvider, "id" | "name" | "enabled">,
  timeZone?: string
): { composed: DashboardProvider["analytics"]; storedToday: HistoryDayRecord | null } {
  try {
    const composed = persistProviderHistory({
      store: history,
      timeZone,
      providerId: providerID,
      accountKey,
      now,
      live
    });
    const storedToday = history.get(providerID, accountKey, localCalendarDay(now));
    return { composed: composed ?? live.analytics, storedToday };
  } catch (error) {
    noteHistoryError("persist", error);
    return {
      composed: safeHistory(
        () => composeFromStore(history, providerID, accountKey, now, live.analytics),
        live.analytics,
        "compose"
      ),
      storedToday: safeHistory(
        () => history.get(providerID, accountKey, localCalendarDay(now)),
        null,
        "read"
      )
    };
  }
}

function fallbackFromHistory(
  history: HistoryStore,
  providerID: string,
  now: Date,
  defaultAccountKey: string
): { today: HistoryDayRecord | null; capacity: HistoryDayRecord | null; composed: DashboardProvider["analytics"] } {
  const today = localCalendarDay(now);
  const startDay = shiftLocalDay(today, -(HISTORY_SNAPSHOT_DAYS - 1));
  const rows = safeHistory(() => history.getRange(providerID, startDay, shiftLocalDay(today, 1)), [], "read");
  const todayRecord = latestHistoryRecord(rows.filter((row) => row.localDay === localCalendarDay(now, row.payload.timeZone ?? undefined)));
  const capacity = history.latestCapacity?.(providerID) ?? latestHistoryRecord(rows.filter((row) => row.payload.windows.length > 0));
  const accountKey = todayRecord?.accountKey ?? capacity?.accountKey ?? latestHistoryRecord(rows)?.accountKey ?? defaultAccountKey;
  return {
    today: todayRecord,
    capacity,
    composed: safeHistory(
      () => composeFromStore(history, providerID, accountKey, now, null),
      null,
      "compose"
    )
  };
}

function firstCapacity(
  previous: DashboardProvider | undefined,
  today: HistoryDayRecord | null,
  stored: HistoryDayRecord | null
): {
  source: string;
  windows: DashboardWindow[];
  identity: DashboardProvider["identity"];
  credits: DashboardProvider["credits"];
  updatedAt: string | null;
} | null {
  const windows = firstWindows(previous?.windows, today?.payload.windows, stored?.payload.windows);
  const identity = previous?.identity ?? today?.payload.identity ?? stored?.payload.identity ?? null;
  const credits = previous?.credits ?? today?.payload.credits ?? stored?.payload.credits ?? null;
  if (windows.length === 0 && identity === null && credits === null && !previous && !today && !stored) {
    return null;
  }
  const source = (previous?.windows.length ? previous.source : null)
    ?? (today?.payload.windows.length ? today.payload.source : null)
    ?? stored?.payload.source
    ?? previous?.source
    ?? today?.payload.source
    ?? "unavailable";
  const updatedAt = (previous?.windows.length ? previous.updatedAt : null)
    ?? today?.payload.capturedAt
    ?? stored?.payload.capturedAt
    ?? previous?.updatedAt
    ?? null;
  return { source, windows, identity, credits, updatedAt };
}

function firstWindows(
  ...candidates: Array<DashboardWindow[] | undefined>
): DashboardWindow[] {
  for (const candidate of candidates) {
    if (candidate && candidate.length > 0) return candidate;
  }
  return [];
}

function latestHistoryRecord(rows: HistoryDayRecord[]): HistoryDayRecord | null {
  return rows.reduce<HistoryDayRecord | null>((best, row) => {
    if (!best) return row;
    if (row.localDay !== best.localDay) return row.localDay > best.localDay ? row : best;
    return row.updatedAt >= best.updatedAt ? row : best;
  }, null);
}

function safeHistory<T>(read: () => T, fallback: T, action: string): T {
  try {
    return read();
  } catch (error) {
    noteHistoryError(action, error);
    return fallback;
  }
}

function noteHistoryError(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : "failed";
  process.stderr.write(`History ${action} failed; continuing (${message})\n`);
}

export { HISTORY_BACKFILL_DAYS };
