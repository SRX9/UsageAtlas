import { createHash } from "node:crypto";
import { StatisticsStore } from "./statistics-store";
import { readHistoryDayPayload } from "./payload";
import { previewModelRecovery } from "./usage-payload";
import {
  canonicalUsage,
  sameUsage,
  validateUsageRecord,
  USAGE_BATCH_SIZE,
  USAGE_MAX_BYTES,
  type CloudRecord,
  type PendingRecord,
  type UsageRecord
} from "@usageatlas/contracts/usage";
import type { WritableSqliteDatabase } from "../platform/sqlite";

export interface LocalRecord extends PendingRecord {
  owner: string;
  details: string | null;
  saveError: string | null;
  savedVersion: number;
  conflict: CloudRecord | null;
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_record (
  owner TEXT NOT NULL DEFAULT '',
  id TEXT NOT NULL,
  provider TEXT NOT NULL,
  day TEXT,
  payload TEXT NOT NULL,
  details TEXT,
  local_version INTEGER NOT NULL DEFAULT 1,
  saved_version INTEGER NOT NULL DEFAULT 0,
  cloud_revision INTEGER NOT NULL DEFAULT 0,
  conflict TEXT,
  save_error TEXT,
  PRIMARY KEY (owner, id)
);
CREATE INDEX IF NOT EXISTS usage_record_day ON usage_record(owner, provider, day);
CREATE INDEX IF NOT EXISTS usage_record_pending ON usage_record(owner, id) WHERE local_version > saved_version AND conflict IS NULL;
CREATE TABLE IF NOT EXISTS usage_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export class UsageStore {
  readonly statistics: StatisticsStore;
  onChange?: () => void;
  constructor(readonly db: WritableSqliteDatabase) {
    db.exec(SCHEMA);
    db.exec(`CREATE TABLE IF NOT EXISTS usage_record_history (
      owner TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      payload TEXT NOT NULL, details TEXT, archived_at TEXT NOT NULL,
      PRIMARY KEY(owner,id,fingerprint)
    )`);
    this.statistics = new StatisticsStore(db, () => this.owner);
    if (!db.all("PRAGMA table_info(usage_record)").some((column) => column.name === "save_error"))
      db.exec("ALTER TABLE usage_record ADD COLUMN save_error TEXT");
  }
  get owner(): string {
    return this.setting("owner") ?? "";
  }
  setting(key: string): string | null {
    return (this.db.get("SELECT value FROM usage_setting WHERE key = ?", [key])?.value as string) ?? null;
  }
  setSetting(key: string, value: string): void {
    this.db.run(
      "INSERT INTO usage_setting VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value]
    );
  }
  selectAccount(owner: string): void {
    this.setSetting("owner", owner);
  }
  claimLocal(): void {
    const owner = this.owner;
    if (!owner) throw new Error("Sign in before saving.");
    this.transaction(() => {
      for (const row of this.db.all("SELECT * FROM usage_record WHERE owner = '' AND save_error IS NULL")) {
        const local = this.decodeForSave(row);
        if (!local) continue;
        // Reconcile overlapping local collection through the normal revision checks.
        const existing = this.get(local.record.recordId);
        this.put(local.record, local.details);
        if (
          existing &&
          existing.revision > 0 &&
          existing.localVersion === existing.savedVersion &&
          !sameUsage(existing.record, local.record)
        ) {
          // This local copy existed before restore, so it has not been edited against that cloud revision.
          this.db.run("UPDATE usage_record SET conflict = ? WHERE owner = ? AND id = ?", [
            JSON.stringify({ record: existing.record, revision: existing.revision }),
            owner,
            local.record.recordId
          ]);
        }
      }
      this.db.run("DELETE FROM usage_record WHERE owner = '' AND save_error IS NULL");
    });
  }
  get(id: string, owner = this.owner): LocalRecord | null {
    const row = this.db.get("SELECT * FROM usage_record WHERE owner = ? AND id = ?", [owner, id]);
    try {
      return row ? decode(row) : null;
    } catch {
      return null;
    }
  }
  localRecord(id: string): LocalRecord | null {
    return this.get(id, "");
  }
  discardAnonymous(id: string): void {
    if (this.owner) this.db.run("DELETE FROM usage_record WHERE owner = '' AND id = ?", [id]);
  }
  records(provider?: string, start?: string, end?: string): LocalRecord[] {
    return this.db
      .all(
        provider
          ? "SELECT * FROM usage_record WHERE owner IN (?, '') AND provider = ? AND (day IS NULL OR day BETWEEN ? AND ?) ORDER BY day, id, owner"
          : "SELECT * FROM usage_record WHERE owner IN (?, '') ORDER BY owner, id",
        provider ? [this.owner, provider, start ?? "0000", end ?? "9999"] : [this.owner]
      )
      .flatMap((row) => {
        try {
          return [decode(row)];
        } catch {
          return [];
        }
      });
  }
  put(record: UsageRecord, details: string | null = null, owner = this.owner): LocalRecord {
    if (record.kind === "usage_day" && details) {
      const source = readHistoryDayPayload(details);
      record = (source && previewModelRecovery(record, source)) || record;
    }
    const existing = this.get(record.recordId, owner);
    if (existing && (details !== existing.details || !sameUsage(existing.record, record))) this.archive(existing);
    if (existing && sameUsage(existing.record, record)) {
      if (details !== existing.details || existing.saveError)
        this.db.run("UPDATE usage_record SET details = ?, save_error = NULL WHERE owner = ? AND id = ?", [
          details,
          owner,
          record.recordId
        ]);
      return { ...existing, details, saveError: null };
    }
    this.db.run(
      `INSERT INTO usage_record (owner, id, provider, day, payload, details) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner, id) DO UPDATE SET payload = excluded.payload, details = excluded.details, conflict = ?, save_error = NULL, local_version = usage_record.local_version + 1`,
      [
        owner,
        record.recordId,
        record.providerId,
        record.kind === "usage_day" ? record.localDay : null,
        canonicalUsage(record),
        details,
        existing?.conflict ? JSON.stringify(existing.conflict) : null
      ]
    );
    return this.get(record.recordId, owner)!;
  }
  pending(): PendingRecord[] {
    const pending: PendingRecord[] = [];
    let bytes = 0;
    let after: string | null = null;
    while (pending.length < USAGE_BATCH_SIZE) {
      const rows = this.db.all(
        "SELECT * FROM usage_record WHERE owner = ? AND local_version > saved_version AND conflict IS NULL AND save_error IS NULL AND (? IS NULL OR id > ?) ORDER BY id LIMIT ?",
        [this.owner, after, after, USAGE_BATCH_SIZE - pending.length]
      );
      if (!rows.length) break;
      for (const row of rows) {
        after = String(row.id);
        const local = this.decodeForSave(row);
        if (!local) continue;
        const record = this.validatePending(local.record);
        const size = Buffer.byteLength(JSON.stringify({ record, revision: local.revision }), "utf8");
        if (bytes + size > USAGE_MAX_BYTES - 4096) {
          if (!pending.length) throw new Error("A usage record is too large to save.");
          return pending;
        }
        bytes += size;
        pending.push({ record, revision: local.revision, localVersion: local.localVersion });
      }
    }
    return pending;
  }
  conflicts(): LocalRecord[] {
    return this.db
      .all("SELECT * FROM usage_record WHERE owner = ? AND conflict IS NOT NULL AND save_error IS NULL ORDER BY id LIMIT 50", [
        this.owner
      ])
      .flatMap((row) => {
        const local = this.decodeForSave(row);
        return local ? [local] : [];
      });
  }
  private validatePending(record: UsageRecord): UsageRecord {
    const timeZone = this.setting(`timezone:${this.owner}:${record.sourceId}`);
    if (
      record.kind === "usage_day" &&
      record.collectionMethod === "provider_history" &&
      record.timeZone &&
      timeZone &&
      record.timeZone !== timeZone
    ) {
      throw new Error("Refresh usage to match the restored reporting timezone, then save again.");
    }
    return record;
  }
  private decodeForSave(row: Record<string, unknown>): LocalRecord | null {
    try {
      const local = decode(row);
      if (local.record.recordId !== row.id) throw new Error("Usage record ID does not match its stored key.");
      return local;
    } catch {
      // Keep the original payload for recovery; a new collection clears this flag.
      this.db.run("UPDATE usage_record SET save_error = ? WHERE owner = ? AND id = ?", [
        "Invalid local usage record", String(row.owner), String(row.id)
      ]);
      return null;
    }
  }
  counts(): { pending: number; conflicts: number; invalid: number } {
    const row = this.db.get(
      "SELECT COALESCE(SUM(local_version > saved_version), 0) AS pending, COALESCE(SUM(conflict IS NOT NULL AND save_error IS NULL), 0) AS conflicts, COALESCE(SUM(local_version > saved_version AND save_error IS NOT NULL), 0) AS invalid FROM usage_record WHERE owner IN (?, '')",
      [this.owner]
    );
    return { pending: Number(row?.pending) + this.statistics.pendingCount(), conflicts: Number(row?.conflicts), invalid: Number(row?.invalid) };
  }
  acknowledge(sent: PendingRecord, remote: CloudRecord): void {
    this.db.run(
      `UPDATE usage_record SET saved_version = MAX(saved_version, ?), cloud_revision = ?, conflict = NULL
      WHERE owner = ? AND id = ? AND cloud_revision <= ?`,
      [sent.localVersion, remote.revision, this.owner, sent.record.recordId, remote.revision]
    );
  }
  merge(remote: CloudRecord): void {
    validateUsageRecord(remote.record);
    if (!Number.isSafeInteger(remote.revision) || remote.revision < 1)
      throw new Error("Invalid cloud revision.");
    this.transaction(() => {
      if (remote.record.kind === "usage_day" && remote.record.timeZone)
        this.setSetting(`timezone:${this.owner}:${remote.record.sourceId}`, remote.record.timeZone);
      const local = this.get(remote.record.recordId);
      if (!local) {
        const inserted = this.put(remote.record, local ? this.compatibleDetails(local, remote.record) : null);
        this.acknowledge(inserted, remote);
      } else if (remote.revision < local.revision) {
        return;
      } else if (sameUsage(local.record, remote.record)) {
        this.acknowledge(local, remote);
      } else if (local.localVersion === local.savedVersion) {
        const updated = this.put(remote.record, local ? this.compatibleDetails(local, remote.record) : null);
        this.acknowledge(updated, remote);
      } else if (remote.revision !== local.revision) {
        this.db.run("UPDATE usage_record SET conflict = ? WHERE owner = ? AND id = ?", [
          JSON.stringify(remote),
          this.owner,
          remote.record.recordId
        ]);
      }
    });
  }
  resolve(id: string, choice: "local" | "cloud"): void {
    this.transaction(() => {
      const local = this.get(id);
      if (!local?.conflict) throw new Error("This conflict no longer exists.");
      const remote = local.conflict;
      if (choice === "cloud") {
        const updated = this.put(remote.record, local ? this.compatibleDetails(local, remote.record) : null);
        this.acknowledge(updated, remote);
      } else {
        this.db.run(
          "UPDATE usage_record SET cloud_revision = ?, conflict = NULL WHERE owner = ? AND id = ?",
          [remote.revision, this.owner, id]
        );
      }
    });
    this.onChange?.();
  }
  private compatibleDetails(local: LocalRecord, incoming: UsageRecord): string | null {
    if (incoming.kind !== "usage_day" || local.record.kind !== "usage_day") return null;
    const previous = local.record.totals, next = incoming.totals;
    if (!previous || !next) return null;
    return (Object.keys(previous) as (keyof typeof previous)[]).every(key => previous[key] === next[key]) ? local.details : null;
  }
  private archive(local: LocalRecord): void {
    const payload = canonicalUsage(local.record);
    const fingerprint = createHash("sha256").update(payload).update(local.details ?? "").digest("hex");
    this.db.run("INSERT OR IGNORE INTO usage_record_history VALUES (?,?,?,?,?,?)", [
      local.owner, local.record.recordId, fingerprint, payload, local.details, new Date().toISOString()
    ]);
  }
  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
function decode(row: Record<string, unknown>): LocalRecord {
  const conflict = row.conflict ? JSON.parse(String(row.conflict)) as CloudRecord : null;
  if (conflict) validateUsageRecord(conflict.record);
  return {
    owner: String(row.owner),
    record: validateUsageRecord(JSON.parse(String(row.payload))),
    revision: Number(row.cloud_revision),
    localVersion: Number(row.local_version),
    savedVersion: Number(row.saved_version),
    details: row.details === null ? null : String(row.details),
    saveError: row.save_error === null ? null : String(row.save_error),
    conflict
  };
}
