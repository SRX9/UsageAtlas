import { randomUUID } from "node:crypto";
import type { DashboardProvider, HistoryDayPayload, HistoryDayRecord } from "@usageatlas/contracts";
import { openWritableSqlite, type WritableSqliteDatabase } from "../platform/sqlite";
import { dayRange } from "./days";
import { canReplaceSealed, emptyUsageTotals, isEmptyHistoryPayload, readHistoryDayPayload } from "./payload";
import { stableId, usageSource, toUsageDay, toCapacity, fromUsageDay } from "./usage-payload";
import { UsageStore, type LocalRecord } from "./usage-store";
import type { HistoryStore } from "./types";

export class SqliteHistoryStore implements HistoryStore {
  readonly usage: UsageStore;
  private constructor(
    private readonly database: WritableSqliteDatabase,
    private readonly replica: string
  ) {
    this.usage = new UsageStore(database);
    this.migrateHistory();
    if (!this.usage.setting("reporting-timezone"))
      this.usage.setSetting("reporting-timezone", Intl.DateTimeFormat().resolvedOptions().timeZone);
  }
  static open(databasePath: string): SqliteHistoryStore {
    const database = openWritableSqlite(databasePath);
    try {
      database.exec("CREATE TABLE IF NOT EXISTS replica (id TEXT PRIMARY KEY NOT NULL)");
      let replica = database.get("SELECT id FROM replica LIMIT 1")?.id;
      if (typeof replica !== "string") {
        replica = randomUUID();
        database.run("INSERT INTO replica VALUES (?)", [String(replica)]);
      }
      return new SqliteHistoryStore(database, String(replica));
    } catch (error) {
      database.close();
      throw error;
    }
  }
  reportingTimeZone(providerId: string, accountKey: string): string {
    // Restored rows use their existing source ID when the provider login is unavailable.
    const restored = this.usage.setting(`timezone:${this.usage.owner}:${accountKey}`);
    if (restored) return restored;
    const source = usageSource(this.replica, providerId, accountKey);
    const key = `timezone:${this.usage.owner}:${source}`;
    const saved = this.usage.setting(key);
    if (saved) return saved;
    const records = this.usage.records(providerId).filter((row) => row.record.sourceId === source);
    for (const row of records) {
      if (row.conflict?.record.kind === "usage_day" && row.conflict.record.timeZone)
        return row.conflict.record.timeZone;
    }
    const known = records
      .sort((a, b) => b.revision - a.revision)
      .find((row) => row.record.kind === "usage_day" && row.record.timeZone);
    const zone =
      known?.record.kind === "usage_day" ? known.record.timeZone! : this.usage.setting("reporting-timezone")!;
    this.usage.setSetting(key, zone);
    return zone;
  }
  needsTimezoneRefresh(providerId: string, accountKey: string): boolean {
    const source = usageSource(this.replica, providerId, accountKey);
    const timeZone = this.reportingTimeZone(providerId, accountKey);
    return this.usage
      .records(providerId)
      .some(
        (row) =>
          row.record.sourceId === source &&
          row.record.kind === "usage_day" &&
          row.record.timeZone !== null &&
          row.record.timeZone !== timeZone
      );
  }
  replicaId(): string {
    return this.replica;
  }
  get(providerId: string, accountKey: string, localDay: string): HistoryDayRecord | null {
    const id = stableId(usageSource(this.replica, providerId, accountKey), localDay);
    const local = this.usage.get(id) ?? this.usage.localRecord(id);
    return local ? this.historyRow(local, accountKey) : null;
  }
  getRange(providerId: string, startDay: string, endDay: string): HistoryDayRecord[] {
    const records = [
      ...new Map(
        this.usage.records(providerId, startDay, endDay).map((row) => [row.record.recordId, row])
      ).values()
    ];
    const capacity = records.filter((row) => row.record.kind === "capacity_snapshot");
    const result = records.flatMap((row) => {
      const history = this.historyRow(row);
      if (!history) return [];
      const current = capacity.find((c) => c.record.sourceId === row.record.sourceId)?.record;
      if (current?.kind === "capacity_snapshot" && !history.payload.windows.length) {
        history.payload.windows = current.windows.map((window) => ({
          kind: window.kind,
          label:
            window.labelKey === "duration"
              ? `${window.durationMinutes! / 60} hours`
              : window.labelKey.replaceAll("_", " "),
          usedPercent: window.usedPercent,
          remainingPercent: Math.max(0, 100 - window.usedPercent),
          resetAt: window.resetAt
        }));
        history.payload.identity = current.planKey ? { plan: current.planKey } : null;
      }
      return [history];
    });
    return result.sort(
      (a, b) => a.localDay.localeCompare(b.localDay) || a.accountKey.localeCompare(b.accountKey)
    );
  }
  missingDays(providerId: string, accountKey: string, startDay: string, endDay: string): string[] {
    return dayRange(startDay, endDay).filter((day) => !this.get(providerId, accountKey, day)?.sealed);
  }
  upsertDraft(
    providerId: string,
    accountKey: string,
    localDay: string,
    payload: HistoryDayPayload
  ): HistoryDayRecord {
    const existing = this.get(providerId, accountKey, localDay);
    if (existing?.sealed) return existing;
    if (
      existing &&
      payload.status === "partial" &&
      (payload.totals.totalTokens < existing.payload.totals.totalTokens ||
        payload.totals.requests < existing.payload.totals.requests)
    )
      return existing;
    return this.write(providerId, accountKey, localDay, payload, false);
  }
  sealDay(
    providerId: string,
    accountKey: string,
    localDay: string,
    payload: HistoryDayPayload
  ): HistoryDayRecord | null {
    const existing = this.get(providerId, accountKey, localDay);
    if (isEmptyHistoryPayload(payload)) return existing?.sealed ? existing : null;
    if (existing?.sealed && !canReplaceSealed(existing.payload, payload)) return existing;
    return this.write(providerId, accountKey, localDay, payload, true);
  }
  sealDraftsBefore(providerId: string, today: string): HistoryDayRecord[] {
    return this.getRange(providerId, "0000", today).flatMap((row) => {
      if (row.sealed || row.localDay >= today || isEmptyHistoryPayload(row.payload)) return [];
      const local = this.usage.get(row.id) ?? this.usage.localRecord(row.id);
      if (local?.record.kind !== "usage_day") return [];
      const updated = this.usage.put({ ...local.record, dayState: "complete" }, local.details, local.owner);
      this.usage.onChange?.();
      return [this.historyRow(updated, row.accountKey)!];
    });
  }
  saveCapacity(
    providerId: string,
    accountKey: string,
    live: Omit<DashboardProvider, "id" | "name" | "enabled">
  ): void {
    if (live.error || !live.updatedAt) return;
    const payload: HistoryDayPayload = {
      payloadVersion: 1,
      accountKey,
      windows: live.windows,
      identity: live.identity ?? null,
      credits: live.credits ?? null,
      source: live.source,
      capturedAt: live.updatedAt,
      status: "unavailable",
      analyticsSource: "local_sessions",
      totals: emptyUsageTotals(),
      hourly: [],
      models: [],
      projects: [],
      sessions: [],
      serviceTiers: [],
      filesScanned: 0,
      recordsProcessed: 0,
      error: null
    };
    const row: HistoryDayRecord = {
      id: "",
      providerId,
      accountKey,
      localDay: live.updatedAt.slice(0, 10),
      sealed: false,
      changeSeq: 0,
      updatedAt: live.updatedAt,
      payload
    };
    const capacity = toCapacity(row, this.replica);
    if (capacity) {
      this.usage.transaction(() => {
        this.usage.put(capacity, JSON.stringify(payload));
        this.usage.discardAnonymous(capacity.recordId);
      });
      this.usage.onChange?.();
    }
  }
  latestCapacity(providerId: string): HistoryDayRecord | null {
    const latest = this.usage
      .records(providerId)
      .filter((row) => row.record.kind === "capacity_snapshot")
      .sort((a, b) => b.record.observedAt.localeCompare(a.record.observedAt))[0];
    if (!latest || latest.record.kind !== "capacity_snapshot") return null;
    const capacity = latest.record;
    const details = latest.details ? readHistoryDayPayload(latest.details) : null;
    const row = fromUsageDay(
      {
        ...capacity,
        kind: "usage_day",
        localDay: capacity.observedAt.slice(0, 10),
        timeZone: null,
        dayState: "open",
        collectionMethod: "local_activity",
        status: "unavailable",
        totals: null,
        hourly: null,
        models: null
      },
      latest.localVersion,
      details
    );
    if (!details) {
      row.payload.windows = capacity.windows.map((window) => ({
        kind: window.kind,
        label:
          window.labelKey === "duration"
            ? `${window.durationMinutes! / 60} hours`
            : window.labelKey.replaceAll("_", " "),
        usedPercent: window.usedPercent,
        remainingPercent: Math.max(0, 100 - window.usedPercent),
        resetAt: window.resetAt
      }));
      row.payload.identity = capacity.planKey ? { plan: capacity.planKey } : null;
    }
    return row;
  }
  close(): void {
    this.database.close();
  }
  private historyRow(local: LocalRecord, accountKey?: string): HistoryDayRecord | null {
    if (local.record.kind !== "usage_day") return null;
    return fromUsageDay(
      local.record,
      local.localVersion,
      local.details ? readHistoryDayPayload(local.details) : null,
      accountKey
    );
  }
  private write(
    providerId: string,
    accountKey: string,
    localDay: string,
    payload: HistoryDayPayload,
    sealed: boolean
  ): HistoryDayRecord {
    const row: HistoryDayRecord = {
      id: "",
      providerId,
      accountKey,
      localDay,
      sealed,
      changeSeq: 0,
      updatedAt: payload.capturedAt,
      payload: { ...payload, accountKey }
    };
    const record = toUsageDay(
      row,
      this.replica,
      payload.timeZone ?? this.reportingTimeZone(providerId, accountKey)
    );
    let saved!: LocalRecord;
    this.usage.transaction(() => {
      saved = this.usage.put(record, JSON.stringify(row.payload));
      this.usage.discardAnonymous(record.recordId);
      const capacity = toCapacity(row, this.replica);
      if (capacity) {
        this.usage.put(capacity, JSON.stringify(row.payload));
        this.usage.discardAnonymous(capacity.recordId);
      }
    });
    this.usage.onChange?.();
    return this.historyRow(saved, accountKey)!;
  }
  private migrateHistory(): void {
    if (this.usage.setting("history-migrated") === "1") return;
    const exists = this.database.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'history_day'"
    );
    this.usage.transaction(() => {
      if (exists) {
        for (const old of this.database.all("SELECT * FROM history_day ORDER BY local_day, updated_at")) {
          const payload = readHistoryDayPayload(String(old.payload));
          if (!payload) continue;
          const row: HistoryDayRecord = {
            id: String(old.id),
            providerId: String(old.provider_id),
            accountKey: String(old.account_key),
            localDay: String(old.local_day),
            sealed: Number(old.sealed) === 1,
            changeSeq: Number(old.change_seq),
            updatedAt: String(old.updated_at),
            payload
          };
          this.usage.put(toUsageDay(row, this.replica, null), JSON.stringify(payload));
          const capacity = toCapacity(row, this.replica);
          if (capacity) {
            this.usage.put(capacity, JSON.stringify(row.payload));
            this.usage.discardAnonymous(capacity.recordId);
          }
        }
      }
      this.usage.setSetting("history-migrated", "1");
    });
  }
}
