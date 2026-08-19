import { randomUUID } from "node:crypto";
import type { HistoryDayPayload, HistoryDayRecord } from "@usageatlas/contracts";
import { openWritableSqlite, type WritableSqliteDatabase } from "../platform/sqlite";
import { dayRange } from "./days";
import { canReplaceSealed, isEmptyHistoryPayload, readHistoryDayPayload } from "./payload";
import type { HistoryStore } from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS replica (
  id TEXT PRIMARY KEY NOT NULL
);
CREATE TABLE IF NOT EXISTS history_day (
  id TEXT PRIMARY KEY NOT NULL,
  provider_id TEXT NOT NULL,
  account_key TEXT NOT NULL,
  local_day TEXT NOT NULL,
  sealed INTEGER NOT NULL,
  change_seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  payload_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (provider_id, account_key, local_day)
);
CREATE INDEX IF NOT EXISTS history_day_provider_day
  ON history_day (provider_id, local_day);
CREATE INDEX IF NOT EXISTS history_day_change_seq
  ON history_day (change_seq);
CREATE TABLE IF NOT EXISTS sync_state (
  replica_id TEXT PRIMARY KEY NOT NULL,
  last_pushed_seq INTEGER NOT NULL DEFAULT 0,
  remote_cursor TEXT NOT NULL DEFAULT ''
);
`;

export class SqliteHistoryStore implements HistoryStore {
  private nextSeq: number;

  private constructor(
    private readonly database: WritableSqliteDatabase,
    private readonly replica: string
  ) {
    const maxSeq = this.database.get("SELECT MAX(change_seq) AS value FROM history_day");
    this.nextSeq = Math.max(1, Number(maxSeq?.value ?? 0) + 1);
  }

  static open(databasePath: string): SqliteHistoryStore {
    const database = openWritableSqlite(databasePath);
    database.exec(SCHEMA);
    let replica = database.get("SELECT id FROM replica LIMIT 1");
    if (!replica || typeof replica.id !== "string") {
      const id = randomUUID();
      database.run("INSERT INTO replica (id) VALUES (?)", [id]);
      database.run(
        "INSERT OR IGNORE INTO sync_state (replica_id, last_pushed_seq, remote_cursor) VALUES (?, 0, '')",
        [id]
      );
      replica = { id };
    } else {
      database.run(
        "INSERT OR IGNORE INTO sync_state (replica_id, last_pushed_seq, remote_cursor) VALUES (?, 0, '')",
        [replica.id]
      );
    }
    return new SqliteHistoryStore(database, String(replica.id));
  }

  replicaId(): string {
    return this.replica;
  }

  get(providerId: string, accountKey: string, localDay: string): HistoryDayRecord | null {
    const row = this.database.get(
      `SELECT id, provider_id, account_key, local_day, sealed, change_seq, updated_at, payload
       FROM history_day
       WHERE provider_id = ? AND account_key = ? AND local_day = ?
       LIMIT 1`,
      [providerId, accountKey, localDay]
    );
    return decodeRow(row);
  }

  getRange(providerId: string, startDay: string, endDay: string): HistoryDayRecord[] {
    return decodeRows(this.database.all(
      `SELECT id, provider_id, account_key, local_day, sealed, change_seq, updated_at, payload
       FROM history_day
       WHERE provider_id = ? AND local_day >= ? AND local_day <= ?
       ORDER BY local_day ASC, account_key ASC`,
      [providerId, startDay, endDay]
    ));
  }

  missingDays(providerId: string, accountKey: string, startDay: string, endDay: string): string[] {
    const sealed = new Set(
      this.database.all(
        `SELECT local_day FROM history_day
         WHERE provider_id = ? AND account_key = ? AND sealed = 1
           AND local_day >= ? AND local_day <= ?`,
        [providerId, accountKey, startDay, endDay]
      ).map((row) => String(row.local_day))
    );
    return dayRange(startDay, endDay).filter((day) => !sealed.has(day));
  }

  upsertDraft(
    providerId: string,
    accountKey: string,
    localDay: string,
    payload: HistoryDayPayload
  ): HistoryDayRecord {
    const existing = this.get(providerId, accountKey, localDay);
    if (existing?.sealed) return existing;
    return this.write(existing ?? undefined, providerId, accountKey, localDay, payload, false);
  }

  sealDay(
    providerId: string,
    accountKey: string,
    localDay: string,
    payload: HistoryDayPayload
  ): HistoryDayRecord | null {
    if (isEmptyHistoryPayload(payload)) {
      const existing = this.get(providerId, accountKey, localDay);
      return existing?.sealed ? existing : null;
    }
    const existing = this.get(providerId, accountKey, localDay);
    if (existing?.sealed && !canReplaceSealed(existing.payload, payload)) return existing;
    return this.write(existing ?? undefined, providerId, accountKey, localDay, payload, true);
  }

  sealDraftsBefore(providerId: string, today: string): HistoryDayRecord[] {
    const drafts = this.database.all(
      `SELECT id, provider_id, account_key, local_day, sealed, change_seq, updated_at, payload
       FROM history_day
       WHERE provider_id = ? AND sealed = 0 AND local_day < ?`,
      [providerId, today]
    );
    return decodeRows(drafts).flatMap((draft) => {
      if (isEmptyHistoryPayload(draft.payload)) return [];
      const sealed = this.sealDay(
        draft.providerId,
        draft.accountKey,
        draft.localDay,
        draft.payload
      );
      return sealed ? [sealed] : [];
    });
  }

  changesSince(changeSeq: number): HistoryDayRecord[] {
    return decodeRows(this.database.all(
      `SELECT id, provider_id, account_key, local_day, sealed, change_seq, updated_at, payload
       FROM history_day
       WHERE change_seq > ?
       ORDER BY change_seq ASC`,
      [changeSeq]
    ));
  }

  applyRemote(records: HistoryDayRecord[]): void {
    for (const remote of records) {
      const existing = this.get(remote.providerId, remote.accountKey, remote.localDay);
      if (!existing) {
        this.write(undefined, remote.providerId, remote.accountKey, remote.localDay, remote.payload, remote.sealed, remote.id);
        continue;
      }
      if (existing.sealed) continue;
      if (remote.sealed) {
        this.write(existing, remote.providerId, remote.accountKey, remote.localDay, remote.payload, true);
      }
    }
  }

  close(): void {
    this.database.close();
  }

  private write(
    existing: HistoryDayRecord | undefined,
    providerId: string,
    accountKey: string,
    localDay: string,
    payload: HistoryDayPayload,
    sealed: boolean,
    preferredId?: string
  ): HistoryDayRecord {
    const record: HistoryDayRecord = {
      id: existing?.id ?? preferredId ?? randomUUID(),
      providerId,
      accountKey,
      localDay,
      sealed,
      changeSeq: this.nextSeq++,
      updatedAt: new Date().toISOString(),
      payload: { ...payload, accountKey }
    };
    this.database.run(
      `INSERT INTO history_day (
         id, provider_id, account_key, local_day, sealed, change_seq, updated_at, payload_version, payload
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id, account_key, local_day) DO UPDATE SET
         sealed = excluded.sealed,
         change_seq = excluded.change_seq,
         updated_at = excluded.updated_at,
         payload_version = excluded.payload_version,
         payload = excluded.payload
       WHERE history_day.sealed = 0
         OR json_extract(history_day.payload, '$.status') = 'partial'
         OR (
           history_day.sealed = 1
           AND json_extract(history_day.payload, '$.totals.totalTokens') = 0
           AND json_extract(history_day.payload, '$.totals.requests') = 0
           AND json_array_length(COALESCE(json_extract(history_day.payload, '$.windows'), '[]')) = 0
           AND NOT EXISTS (
             SELECT 1
             FROM json_each(COALESCE(json_extract(history_day.payload, '$.hourly'), '[]')) AS hour
             WHERE COALESCE(json_extract(hour.value, '$.totalTokens'), 0) > 0
                OR COALESCE(json_extract(hour.value, '$.requests'), 0) > 0
           )
         )`,
      [
        record.id,
        record.providerId,
        record.accountKey,
        record.localDay,
        record.sealed ? 1 : 0,
        record.changeSeq,
        record.updatedAt,
        record.payload.payloadVersion,
        JSON.stringify(record.payload)
      ]
    );
    return this.get(providerId, accountKey, localDay) ?? record;
  }
}

function decodeRows(rows: Record<string, unknown>[]): HistoryDayRecord[] {
  return rows.flatMap((row) => {
    const decoded = decodeRow(row);
    return decoded ? [decoded] : [];
  });
}

function decodeRow(row: Record<string, unknown> | null): HistoryDayRecord | null {
  if (!row) return null;
  const payload = readHistoryDayPayload(String(row.payload ?? ""));
  if (!payload) return null;
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    accountKey: String(row.account_key),
    localDay: String(row.local_day),
    sealed: Number(row.sealed) === 1,
    changeSeq: Number(row.change_seq),
    updatedAt: String(row.updated_at),
    payload
  };
}
