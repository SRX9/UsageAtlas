import { inflateRawSync } from "node:zlib";
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
  type StoredTotals,
  type UsageDay,
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
  reported TEXT,
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
    // Earlier builds kept a write-only copy of every replaced projection. It was
    // the largest table in this file and nothing could read it back, so it is
    // dropped and never written again.
    db.exec("DROP TABLE IF EXISTS usage_record_history");
    this.statistics = new StatisticsStore(db, () => this.owner);
    if (!db.all("PRAGMA table_info(usage_record)").some((column) => column.name === "save_error"))
      db.exec("ALTER TABLE usage_record ADD COLUMN save_error TEXT");
    if (!db.all("PRAGMA table_info(usage_record)").some((column) => column.name === "reported"))
      db.exec("ALTER TABLE usage_record ADD COLUMN reported TEXT");
    this.repair();
    this.compact();
  }
  /**
   * Collapses the ledger to what the app still needs to upload or show, then
   * returns the freed pages to the file system once. Until now every scan filed a
   * `collection` fact, every quota check a `capacity` fact, and every cloud save
   * kept the acknowledged request rows forever: 2,597 of 2,856 rows on a real
   * profile carried no usage at all. The day record above already sums the same
   * requests, so those rows are redundant.
   */
  private compact(): void {
    const removed = this.statistics.compact();
    this.restoreStoredDetails();
    this.migrateAttributionLabels();
    const version = this.setting("storage-compact");
    const freed = Number(this.db.get("PRAGMA freelist_count")?.freelist_count ?? 0);
    // Bump when a build frees pages without removing rows (dropped indexes,
    // labels moved onto their rows), so the file is rewritten once on upgrade.
    const CODE_LAYOUT = "3";
    if (version === CODE_LAYOUT && removed === 0 && freed < 64) return;
    try {
      // The writer connection can hold the file between batches; the deletions are
      // already committed and VACUUM can run on the next launch.
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.db.exec("VACUUM");
      this.setSetting("storage-compact", CODE_LAYOUT);
    } catch {
      // Reclaiming space is best effort; deleted rows still free their pages.
    }
  }
  /**
   * Moves labels an earlier build kept in `usage_setting` onto the rows they
   * name, then drops the settings rows. Labels whose row is already gone are
   * simply discarded, which is also what pruning did.
   */
  private migrateAttributionLabels(): void {
    if (this.setting("attribution-columns") === "1") return;
    this.db.run(`UPDATE usage_fact SET reported = (SELECT value FROM usage_setting
        WHERE key = 'attribution:fact:' || usage_fact.id)
      WHERE reported IS NULL AND EXISTS (SELECT 1 FROM usage_setting
        WHERE key = 'attribution:fact:' || usage_fact.id)`);
    this.db.run(`UPDATE usage_record SET reported = (SELECT value FROM usage_setting
        WHERE key = 'attribution:record:' || usage_record.id)
      WHERE reported IS NULL AND EXISTS (SELECT 1 FROM usage_setting
        WHERE key = 'attribution:record:' || usage_record.id)`);
    this.db.run("DELETE FROM usage_setting WHERE key LIKE 'attribution:fact:%' OR key LIKE 'attribution:record:%'");
    this.setSetting("attribution-columns", "1");
  }

  /**
   * 0.4.1 deflated a day's display detail to save space. A later build writes
   * the plain JSON again, because a compressed blob is opaque to every outside
   * reader and the user asked for the old, readable format back. Existing rows
   * are rewritten once on the next launch.
   */
  private restoreStoredDetails(): void {
    for (;;) {
      const rows = this.db.all(
        "SELECT owner, id, details FROM usage_record WHERE details LIKE ? LIMIT 500",
        [`${DETAILS_PREFIX}%`]
      );
      if (!rows.length) return;
      for (const row of rows) {
        const decoded = decodeDetails(row.details);
        if (decoded === null) continue;
        this.db.run("UPDATE usage_record SET details = ? WHERE owner = ? AND id = ?", [
          decoded,
          String(row.owner),
          String(row.id)
        ]);
      }
    }
  }
  get owner(): string {
    return this.setting("owner") ?? "";
  }
  /**
   * Rewrites every stored day and its display detail at one blended rate, in
   * USD per million tokens. Catalog prices on private model names are not the
   * invoice, so history recorded before the rate was chosen has to move too;
   * otherwise the total keeps the old estimate while new requests use the new
   * one. Returns how many rows changed.
   */
  repriceDayCosts(ratePerMillion: number): number {
    if (!Number.isFinite(ratePerMillion) || ratePerMillion <= 0) return 0;
    let changed = 0;
    for (const local of this.records()) {
      if (local.record.kind !== "usage_day") continue;
      const record = repriceUsageDay(local.record, ratePerMillion);
      const details = local.details ? repriceDetails(local.details, ratePerMillion) : null;
      if (record === local.record && details === local.details) continue;
      this.put(record, details, local.owner);
      changed += 1;
    }
    return changed;
  }
  /**
   * Drops day records and observations older than the retention window. The
   * `usage_event_seen` fingerprints stay, so a later rescan cannot resurrect a day
   * the user chose to forget.
   */
  pruneBeforeDays(days: number): number {
    const cutoffDay = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const cutoffAt = `${cutoffDay}T00:00:00.000Z`;
    const before = Number(this.db.get("SELECT COUNT(*) AS count FROM usage_record")?.count ?? 0)
      + Number(this.db.get("SELECT COUNT(*) AS count FROM usage_fact")?.count ?? 0);
    this.transaction(() => {
      this.db.run("DELETE FROM usage_record WHERE day IS NOT NULL AND day < ?", [cutoffDay]);
      this.db.run("DELETE FROM usage_fact WHERE occurred_at < ?", [cutoffAt]);
    });
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.db.exec("VACUUM");
    } catch {
      // Space is reclaimed on the next launch if the writer is holding the file.
    }
    const after = Number(this.db.get("SELECT COUNT(*) AS count FROM usage_record")?.count ?? 0)
      + Number(this.db.get("SELECT COUNT(*) AS count FROM usage_fact")?.count ?? 0);
    return Math.max(0, before - after);
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
  /**
   * Clears state that earlier builds left behind: a cloud copy merged with the
   * local breakdown can contradict itself (`Breakdowns exceed daily usage`), and
   * the `save_error` it caused then hides a perfectly valid local record from
   * analytics and from every later save. Neither can ever be applied, so both
   * are dropped and the local record becomes uploadable again.
   */
  private repair(): void {
    for (const row of this.db.all("SELECT * FROM usage_record WHERE conflict IS NOT NULL OR save_error IS NOT NULL")) {
      const owner = String(row.owner), id = String(row.id);
      const conflict = readConflict(row.conflict);
      let local: UsageRecord | null = null;
      try {
        local = validateUsageRecord(JSON.parse(String(row.payload)));
      } catch {
        // The local payload itself is unreadable; keep the flags for recovery.
      }
      if (row.conflict !== null) {
        if (!conflict) this.db.run("UPDATE usage_record SET conflict = NULL WHERE owner = ? AND id = ?", [owner, id]);
        else if (local && conflict.record.providerId !== local.providerId) {
          // The same record was reported under another provider when the wheel was
          // weighted differently. This machine's own earlier upload becomes the
          // label, and the local copy continues from the revision it reached.
          this.setAttribution(`record:${id}`, attributionOf(conflict.record));
          this.db.run("UPDATE usage_record SET cloud_revision = ?, conflict = NULL WHERE owner = ? AND id = ?", [
            conflict.revision,
            owner,
            id
          ]);
        }
      }
      if (row.save_error !== null && local)
        this.db.run("UPDATE usage_record SET save_error = NULL WHERE owner = ? AND id = ?", [owner, id]);
    }
  }
  /**
   * The attribution (`provider|model`) a record was already reported as. The
   * reporting wheel may be re-weighted between runs, but a record the server
   * already holds under one provider must keep it: the server refuses the same
   * record under another provider at the same revision.
   *
   * The label lives on the row it describes. A settings row keyed by the record
   * id cost roughly a hundred bytes each, on a separate table and index, for a
   * value that can only be useful while its row exists.
   */
  attribution(key: string): string | null {
    const target = attributionRow(key);
    if (!target) return this.setting(`attribution:${key}`);
    const row = this.db.get(
      `SELECT reported FROM ${target.table} WHERE id = ? AND reported IS NOT NULL ORDER BY owner = ? DESC LIMIT 1`,
      [target.id, this.owner]
    );
    return row ? String(row.reported) : null;
  }
  setAttribution(key: string, value: string): void {
    const target = attributionRow(key);
    if (!target) return this.setSetting(`attribution:${key}`, value);
    this.db.run(`UPDATE ${target.table} SET reported = ? WHERE id = ?`, [value, target.id]);
  }
  /** Keeps the first attribution this machine used for a record. */
  rememberAttribution(key: string, value: string): void {
    if (this.attribution(key) === null) this.setAttribution(key, value);
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
  /**
   * Records waiting to be saved, optionally limited to providers the server
   * accepts, so a source it does not model cannot hide the ones it can save.
   */
  pending(providers?: readonly string[]): PendingRecord[] {
    // An explicitly empty scope means nothing is uploadable, not everything.
    if (providers && !providers.length) return [];
    const pending: PendingRecord[] = [];
    let bytes = 0;
    let after: string | null = null;
    const scope = providers ? ` AND provider IN (${providers.map(() => "?").join(",")})` : "";
    while (pending.length < USAGE_BATCH_SIZE) {
      const rows = this.db.all(
        `SELECT * FROM usage_record WHERE owner = ? AND local_version > saved_version AND conflict IS NULL AND save_error IS NULL AND (? IS NULL OR id > ?)${scope} ORDER BY id LIMIT ?`,
        [this.owner, after, after, ...(providers ?? []), USAGE_BATCH_SIZE - pending.length]
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
      this.clearSaveError(row);
      return local;
    } catch {
      // Keep the original payload for recovery; a new collection clears this flag.
      this.db.run("UPDATE usage_record SET save_error = ? WHERE owner = ? AND id = ?", [
        "Invalid local usage record", String(row.owner), String(row.id)
      ]);
      return null;
    }
  }
  /** Drops a recovered record's stale flag so the next save sends it again. */
  private clearSaveError(row: Record<string, unknown>): void {
    if (row.save_error === null) return;
    this.db.run("UPDATE usage_record SET save_error = NULL WHERE owner = ? AND id = ?", [
      String(row.owner), String(row.id)
    ]);
  }
  /** Providers of the records still waiting to be saved, in stable order. */
  pendingProviders(): string[] {
    return this.db
      .all("SELECT DISTINCT provider FROM usage_record WHERE owner IN (?, '') AND local_version > saved_version AND conflict IS NULL AND save_error IS NULL ORDER BY provider", [this.owner])
      .map((row) => String(row.provider));
  }
  /**
   * Pending rows for the given providers, including the ones a save has to skip
   * (conflicts and unreadable payloads), so a caller can subtract what the server
   * will never take from the total it reports.
   */
  pendingCount(providers: readonly string[]): number {
    if (!providers.length) return 0;
    const scope = providers.map(() => "?").join(", ");
    const row = this.db.get(
      `SELECT COUNT(*) AS count FROM usage_record WHERE owner IN (?, '') AND local_version > saved_version AND provider IN (${scope})`,
      [this.owner, ...providers]
    );
    return Number(row?.count ?? 0);
  }
  /** Pending rows a save would actually send for the given providers. */
  uploadableCount(providers: readonly string[]): number {
    if (!providers.length) return 0;
    const scope = providers.map(() => "?").join(", ");
    const row = this.db.get(
      `SELECT COUNT(*) AS count FROM usage_record WHERE owner IN (?, '') AND local_version > saved_version AND conflict IS NULL AND save_error IS NULL AND provider IN (${scope})`,
      [this.owner, ...providers]
    );
    return Number(row?.count ?? 0);
  }
  counts(): { pending: number; conflicts: number; invalid: number } {
    const row = this.db.get(
      "SELECT COALESCE(SUM(local_version > saved_version), 0) AS pending, COALESCE(SUM(conflict IS NOT NULL AND save_error IS NULL), 0) AS conflicts, COALESCE(SUM(local_version > saved_version AND save_error IS NOT NULL), 0) AS invalid FROM usage_record WHERE owner IN (?, '')",
      [this.owner]
    );
    return { pending: Number(row?.pending) + this.statistics.pendingCount(), conflicts: Number(row?.conflicts), invalid: Number(row?.invalid) };
  }
  /**
   * Parks a pending row as a conflict with the copy the server answered about.
   * Used when a save acknowledgement leaves the row exactly as it was: the user
   * gets the local/cloud choice instead of a save that can never finish.
   */
  hold(id: string, remote: CloudRecord): void {
    validateUsageRecord(remote.record);
    this.db.run(
      "UPDATE usage_record SET conflict = ? WHERE owner = ? AND id = ? AND local_version > saved_version AND conflict IS NULL",
      [JSON.stringify(remote), this.owner, id]
    );
    this.onChange?.();
  }
  /**
   * Days with no usage at all do not belong on the server: they read as saved
   * days without data and made the public profile call the whole month
   * incomplete. Locally they stay, because they still prove a day was checked.
   */
  skipEmptyDays(): number {
    const before = Number(this.db.get(
      "SELECT COUNT(*) AS count FROM usage_record WHERE owner = ? AND local_version > saved_version AND conflict IS NULL AND save_error IS NULL",
      [this.owner]
    )?.count ?? 0);
    this.db.run(
      `UPDATE usage_record SET saved_version = local_version
       WHERE owner = ? AND local_version > saved_version AND conflict IS NULL AND save_error IS NULL
       AND CASE WHEN json_valid(payload) THEN
         json_extract(payload, '$.kind') = 'usage_day'
         AND (json_extract(payload, '$.status') = 'no_data'
           OR COALESCE(json_extract(payload, '$.totals.totalTokens'), 0) = 0)
       ELSE 0 END`,
      [this.owner]
    );
    const after = Number(this.db.get(
      "SELECT COUNT(*) AS count FROM usage_record WHERE owner = ? AND local_version > saved_version AND conflict IS NULL AND save_error IS NULL",
      [this.owner]
    )?.count ?? 0);
    return before - after;
  }
  /**
   * Re-sends the last closed days once per calendar day. A day first uploaded
   * while it was still open keeps that `open` copy on the server unless a later
   * save rewrites it, which is what the public profile reports as an incomplete
   * saved day even though the local history is complete.
   */
  reassertRecentDays(today: string, days = 2): number {
    const cutoff = new Date(`${today}T00:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - days);
    const from = cutoff.toISOString().slice(0, 10);
    const before = Number(this.db.get(
      "SELECT COUNT(*) AS count FROM usage_record WHERE owner = ? AND local_version > saved_version",
      [this.owner]
    )?.count ?? 0);
    this.db.run(
      `UPDATE usage_record SET local_version = local_version + 1
       WHERE owner = ? AND conflict IS NULL AND save_error IS NULL AND local_version = saved_version
       AND json_extract(payload, '$.kind') = 'usage_day'
       AND json_extract(payload, '$.dayState') = 'complete'
       AND json_extract(payload, '$.status') = 'available'
       AND COALESCE(json_extract(payload, '$.totals.totalTokens'), 0) > 0
       AND day >= ?`,
      [this.owner, from]
    );
    const after = Number(this.db.get(
      "SELECT COUNT(*) AS count FROM usage_record WHERE owner = ? AND local_version > saved_version",
      [this.owner]
    )?.count ?? 0);
    return after - before;
  }
  acknowledge(sent: PendingRecord, remote: CloudRecord): void {
    this.db.run(
      `UPDATE usage_record SET saved_version = MAX(saved_version, ?), cloud_revision = ?, conflict = NULL
      WHERE owner = ? AND id = ? AND cloud_revision <= ?`,
      [sent.localVersion, remote.revision, this.owner, sent.record.recordId, remote.revision]
    );
  }
  /**
   * Merges one cloud copy into the local ledger. `localize` maps a cloud copy back
   * onto the local record it came from, so a record uploaded under another
   * provider does not rename the row counted on this computer.
   */
  merge(remote: CloudRecord, localize?: (incoming: UsageRecord, local: UsageRecord) => UsageRecord): void {
    validateUsageRecord(remote.record);
    if (!Number.isSafeInteger(remote.revision) || remote.revision < 1)
      throw new Error("Invalid cloud revision.");
    this.transaction(() => {
      if (remote.record.kind === "usage_day" && remote.record.timeZone)
        this.setSetting(`timezone:${this.owner}:${remote.record.sourceId}`, remote.record.timeZone);
      const local = this.get(remote.record.recordId);
      const incoming = local && localize ? localize(remote.record, local.record) : remote.record;
      // The cloud copy carries the label this machine reported the record under, and
      // the server refuses that record under any other provider from now on.
      if (local && remote.record.providerId !== local.record.providerId)
        this.setAttribution(`record:${remote.record.recordId}`, attributionOf(remote.record));
      if (!local) {
        const inserted = this.put(incoming, null);
        this.acknowledge(inserted, remote);
      } else if (remote.revision < local.revision) {
        return;
      } else if (sameUsage(local.record, incoming)) {
        this.acknowledge(local, remote);
      } else if (local.localVersion === local.savedVersion) {
        const updated = this.put(incoming, this.compatibleDetails(local, incoming));
        this.acknowledge(updated, remote);
      } else if (this.reportedAs(remote.record, local.record) && remote.revision > local.revision) {
        // Same day, same attribution, newer local usage: this machine is simply
        // ahead of its own earlier upload. Continue from the revision the server
        // holds instead of leaving the record pending forever.
        this.db.run("UPDATE usage_record SET cloud_revision = ? WHERE owner = ? AND id = ?", [
          remote.revision,
          this.owner,
          local.record.recordId
        ]);
      } else {
        // The server holds another copy at this revision. Offering the choice is
        // the only honest move: quietly skipping it left the row pending forever,
        // and every later save stopped with `Cloud save made no progress`.
        this.db.run("UPDATE usage_record SET conflict = ? WHERE owner = ? AND id = ?", [
          JSON.stringify({ ...remote, record: incoming }),
          this.owner,
          incoming.recordId
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
        if (remote.record.providerId !== local.record.providerId)
          this.rememberAttribution(`record:${id}`, attributionOf(remote.record));
        this.db.run(
          "UPDATE usage_record SET cloud_revision = ?, conflict = NULL WHERE owner = ? AND id = ?",
          [remote.revision, this.owner, id]
        );
      }
    });
    this.onChange?.();
  }
  private reportedAs(remote: UsageRecord, local: UsageRecord): boolean {
    return this.attribution(`record:${local.recordId}`) === attributionOf(remote);
  }
  private compatibleDetails(local: LocalRecord, incoming: UsageRecord): string | null {
    if (incoming.kind !== "usage_day" || local.record.kind !== "usage_day") return null;
    const previous = local.record.totals, next = incoming.totals;
    if (!previous || !next) return null;
    return (Object.keys(previous) as (keyof typeof previous)[]).every(key => previous[key] === next[key]) ? local.details : null;
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
/**
 * Separates a stored label's provider from its model. A NUL byte cannot be used:
 * the SQLite binding truncates strings at it, which silently dropped the model.
 */
export const ATTRIBUTION_SEPARATOR = "|";
/** The row a stored attribution label describes; labels never stand alone. */
const ATTRIBUTION_TABLES = { fact: "usage_fact", record: "usage_record" } as const;
function attributionRow(key: string): { table: string; id: string } | null {
  const cut = key.indexOf(":");
  if (cut < 1) return null;
  const table = ATTRIBUTION_TABLES[key.slice(0, cut) as keyof typeof ATTRIBUTION_TABLES];
  return table ? { table, id: key.slice(cut + 1) } : null;
}
/** How one uploaded record is labelled: the provider the server sees and its model. */
export function attributionOf(record: UsageRecord): string {
  const models = record.kind === "usage_day" ? record.models : null;
  return `${record.providerId}${ATTRIBUTION_SEPARATOR}${models?.[0]?.modelKey ?? ""}`;
}
export function parseAttribution(value: string): { reportAs: string; model: string } {
  const cut = value.indexOf(ATTRIBUTION_SEPARATOR);
  return cut === -1
    ? { reportAs: value, model: "" }
    : { reportAs: value.slice(0, cut), model: value.slice(cut + 1) };
}
/**
 * The marker 0.4.1 wrote in front of a deflated day detail. New rows are plain
 * JSON; this remains so an upgrade can find and expand the old ones.
 */
const DETAILS_PREFIX = "z1:";

function decodeDetails(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const stored = String(value);
  if (!stored.startsWith(DETAILS_PREFIX)) return stored;
  try {
    return inflateRawSync(Buffer.from(stored.slice(DETAILS_PREFIX.length), "base64")).toString("utf8");
  } catch {
    return null;
  }
}

function repricedTotals(totals: StoredTotals, ratePerMillion: number): StoredTotals | null {
  if (totals.totalTokens <= 0) return null;
  // Micro-dollars are token count times the per-million rate: 1M × 0.54 = 540000.
  const estimatedCostMicrosUSD = Math.round(totals.totalTokens * ratePerMillion);
  if (totals.estimatedCostMicrosUSD === estimatedCostMicrosUSD && totals.unpricedTokens === 0) return null;
  return { ...totals, estimatedCostMicrosUSD, unpricedTokens: 0 };
}

function repriceUsageDay(record: UsageDay, ratePerMillion: number): UsageDay {
  const totals = record.totals ? repricedTotals(record.totals, ratePerMillion) : null;
  const hourly = record.hourly?.map((hour) => {
    const repriced = repricedTotals(hour.totals, ratePerMillion);
    return repriced ? { ...hour, totals: repriced } : hour;
  });
  const models = record.models?.map((model) => {
    const repriced = repricedTotals(model.totals, ratePerMillion);
    return repriced ? { ...model, totals: repriced } : model;
  });
  if (!totals && !hourly?.some((hour, index) => hour !== record.hourly?.[index])
    && !models?.some((model, index) => model !== record.models?.[index])) return record;
  return {
    ...record,
    ...(totals ? { totals } : {}),
    ...(hourly ? { hourly } : {}),
    ...(models ? { models } : {})
  };
}

function repriceDetails(text: string, ratePerMillion: number): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  return repriceDetailValue(value, ratePerMillion) ? JSON.stringify(value) : text;
}

/** Mutates every totals object in a day detail and reports whether anything moved. */
function repriceDetailValue(value: unknown, ratePerMillion: number): boolean {
  if (Array.isArray(value)) return value.reduce((changed, entry) => repriceDetailValue(entry, ratePerMillion) || changed, false);
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  let changed = false;
  if (typeof row.totalTokens === "number" && typeof row.estimatedCostMicrosUSD !== "undefined") {
    const updated = repricedTotals(row as unknown as StoredTotals, ratePerMillion);
    if (updated) {
      row.estimatedCostMicrosUSD = updated.estimatedCostMicrosUSD;
      row.unpricedTokens = updated.unpricedTokens;
      changed = true;
    }
  }
  for (const entry of Object.values(row)) {
    if (repriceDetailValue(entry, ratePerMillion)) changed = true;
  }
  return changed;
}

function decode(row: Record<string, unknown>): LocalRecord {
  const conflict = readConflict(row.conflict);
  return {
    owner: String(row.owner),
    record: validateUsageRecord(JSON.parse(String(row.payload))),
    revision: Number(row.cloud_revision),
    localVersion: Number(row.local_version),
    savedVersion: Number(row.saved_version),
    details: decodeDetails(row.details),
    saveError: row.save_error === null ? null : String(row.save_error),
    conflict
  };
}
/**
 * A stored cloud copy only ever offers a choice, so an unreadable one is dropped
 * instead of blocking the local record it was compared with.
 */
function readConflict(value: unknown): CloudRecord | null {
  if (value === null || value === undefined) return null;
  try {
    const conflict = JSON.parse(String(value)) as CloudRecord;
    validateUsageRecord(conflict.record);
    return Number.isSafeInteger(conflict.revision) && conflict.revision >= 1 ? conflict : null;
  } catch {
    return null;
  }
}
