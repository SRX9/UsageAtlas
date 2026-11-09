import { createHash } from "node:crypto";
import type { DashboardProvider, LocalUsageAnalytics } from "@usageatlas/contracts";
import { factContent, validateUsageFact, STATISTICS_BATCH_SIZE, STATISTICS_MAX_BYTES, type UsageFact, type UsageEventFact } from "@usageatlas/contracts/statistics";
import type { UsageProvider } from "@usageatlas/contracts/usage";
import type { SqliteOperation, WritableSqliteDatabase } from "../platform/sqlite";
import { stableId, usageSource } from "./usage-payload";

export function identifyFact<T extends UsageFact>(fact: T): T {
  const id = createHash("sha256").update(factContent(fact)).digest("hex");
  return validateUsageFact({ ...fact, id }) as T;
}
export function checkFact(fact: unknown): UsageFact {
  return fingerprint(fact).fact;
}
interface Fingerprinted { fact: UsageFact; contentId: string | null }
/** Checks a fact's id and fingerprints an event's content apart from its pricing catalog revision. */
function fingerprint(value: unknown): Fingerprinted {
  const fact = validateUsageFact(value);
  const content = factContent(fact);
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  if (hash(content) !== fact.id) throw new Error("Usage observation fingerprint does not match.");
  if (fact.kind !== "usage_event") return { fact, contentId: null };
  // factContent sorts keys and only scalar fields sort before pricingVersion, so the first match is that field.
  return { fact, contentId: hash(content.replace(`"pricingVersion":${JSON.stringify(fact.pricingVersion)}`, `"pricingVersion":null`)) };
}

/** Immutable numeric observations, independently recoverable from display summaries. */
export class StatisticsStore {
  constructor(private readonly db: WritableSqliteDatabase, private readonly owner: () => string) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_fact (
        owner TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL,
        kind TEXT NOT NULL, provider TEXT NOT NULL, occurred_at TEXT NOT NULL,
        event_id TEXT, model TEXT, project_id TEXT, session_id TEXT,
        payload TEXT NOT NULL, saved INTEGER NOT NULL DEFAULT 0 CHECK (saved IN (0,1)),
        content_id TEXT,
        PRIMARY KEY(owner,id)
      );
      CREATE INDEX IF NOT EXISTS usage_fact_pending ON usage_fact(owner,id) WHERE saved = 0;
      CREATE INDEX IF NOT EXISTS usage_fact_time ON usage_fact(owner,provider,occurred_at);
      CREATE INDEX IF NOT EXISTS usage_fact_model ON usage_fact(owner,model,occurred_at);
      CREATE INDEX IF NOT EXISTS usage_fact_event ON usage_fact(owner,event_id);
      CREATE INDEX IF NOT EXISTS usage_fact_project ON usage_fact(owner,project_id,occurred_at);
      CREATE VIEW IF NOT EXISTS usage_event_latest AS
        SELECT * FROM (
          SELECT f.*, COUNT(*) OVER (PARTITION BY owner,event_id) AS observation_versions,
            ROW_NUMBER() OVER (PARTITION BY owner,event_id
              ORDER BY json_extract(payload, '$.observedAt') DESC,id DESC) AS observation_rank
          FROM usage_fact f WHERE kind = 'usage_event'
        ) observations WHERE observation_rank = 1;
    `);
    if (!db.all("PRAGMA table_info(usage_fact)").some(column => column.name === "content_id"))
      db.exec("ALTER TABLE usage_fact ADD COLUMN content_id TEXT");
  }
  put(fact: UsageFact, saved = false, owner = this.owner()): void {
    const checked = fingerprint(fact);
    const rowid = this.insert(checked, saved, owner);
    if (rowid !== null && checked.fact.kind === "usage_event") this.keepObservationOrder(owner, checked.fact, rowid);
  }
  /** Returns the rowid of the inserted fact, or null when it was already stored or repeats the newest version. */
  private insert(checked: Fingerprinted, saved: boolean, owner: string): number | null {
    const operation = insertOperation(checked, owner, saved);
    this.db.run(operation.sql, operation.parameters);
    const inserted = this.db.get("SELECT changes() AS changes, last_insert_rowid() AS rowid");
    if (saved) this.db.run("UPDATE usage_fact SET saved = 1 WHERE owner = ? AND id = ?", [owner, checked.fact.id]);
    return inserted?.changes ? Number(inserted.rowid) : null;
  }
  /**
   * Scans add versions in observation order, so the newest version of an event has the highest rowid.
   * A restored version can be older than versions already stored; those move back behind it, in observation order.
   */
  private keepObservationOrder(owner: string, r: UsageEventFact, rowid: number): void {
    const parameters = [owner, r.eventId, rowid, r.observedAt, r.id];
    const observedLater = "(json_extract(payload, '$.observedAt'), id) > (?4, ?5)";
    // Earlier versions are already in order, so the newest of them decides whether any is later.
    if (!this.db.get(`SELECT 1 FROM usage_fact WHERE rowid = (SELECT rowid FROM usage_fact
      WHERE owner = ?1 AND event_id = ?2 AND rowid < ?3 ORDER BY rowid DESC LIMIT 1) AND ${observedLater}`, parameters)) return;
    const later = this.db.all(`SELECT rowid FROM usage_fact WHERE owner = ?1 AND event_id = ?2 AND rowid < ?3 AND ${observedLater}
      ORDER BY json_extract(payload, '$.observedAt'), id`, parameters);
    for (const row of later) this.db.run("UPDATE usage_fact SET rowid = (SELECT max(rowid) + 1 FROM usage_fact) WHERE rowid = ?", [Number(row.rowid)]);
  }
  async putBatch(facts: UsageFact[], owner: string, completion?: { key: string; version: string }): Promise<void> {
    const operations = facts.map(fact => insertOperation(fingerprint(fact), owner, false));
    if (completion) operations.push({ sql: "DELETE FROM usage_setting WHERE key = ? AND value = ?", parameters: [completion.key, completion.version] });
    await this.db.commit(operations);
  }
  collect(provider: UsageProvider, account: string, replica: string, analytics: LocalUsageAnalytics): void {
    const owner = this.owner();
    for (const fact of this.observations(provider, account, replica, analytics)) this.insert(fingerprint(fact), false, owner);
  }
  *observations(provider: UsageProvider, account: string, replica: string, analytics: LocalUsageAnalytics): Generator<UsageFact> {
    const collection = analytics.collection;
    if (!collection) return;
    const sourceId = usageSource(replica, provider, account);
    for (const record of collection.events) {
      const fact: UsageEventFact = {
        schemaVersion: 1, id: "", kind: "usage_event", sourceId, providerId: provider,
        eventId: stableId(record.eventIdentity === "source" ? provider : sourceId, "event", record.eventKey),
        eventIdentity: record.eventIdentity ?? "fingerprint",
        occurredAt: record.timestamp, observedAt: analytics.updatedAt, timeZone: collection.timeZone,
        modelKey: record.model, reportedModel: record.reportedModel ?? record.model,
        modelProvider: record.modelProvider ?? null,
        sessionId: provider !== "cursor" && record.sessionID && record.sessionID !== "unknown-session" ? stableId(provider, "session", record.sessionID) : null,
        projectId: record.projectPath ? stableId(replica, "project", record.projectPath) : null,
        serviceTier: record.serviceTier || null, granularity: record.granularity ?? "event",
        measurement: record.measurement ?? "known",
        totals: record.measurement === "unknown" ? null : {
          inputTokens: record.inputTokens, cachedInputTokens: record.cachedInputTokens,
          cacheCreationInputTokens: record.cacheCreationInputTokens, outputTokens: record.outputTokens,
          totalTokens: record.totalTokens, requests: 1,
          estimatedCostMicrosUSD: record.estimatedCostUSD === null ? null : Math.round(record.estimatedCostUSD * 1_000_000),
          unpricedTokens: record.estimatedCostUSD === null ? record.totalTokens : 0
        },
        rawTokens: record.rawTokens ?? { input: record.inputTokens, cacheRead: record.cachedInputTokens,
          cacheWrite: record.cacheCreationInputTokens, output: record.outputTokens },
        reportedCostUSD: record.reportedCostUSD ?? null,
        estimatedCostUSD: record.estimatedCostUSD,
        pricingVersion: record.pricingVersion ?? collection.pricingVersion,
        parserVersion: collection.parserVersion
      };
      yield identifyFact(fact);
    }
    const { events: _events, ...provenance } = collection;
    void _events;
    yield identifyFact({ schemaVersion: 1, id: "", kind: "collection", sourceId, providerId: provider,
      observedAt: analytics.updatedAt, ...provenance });
  }
  capacity(provider: UsageProvider, account: string, replica: string, live: Omit<DashboardProvider, "id" | "name" | "enabled">): void {
    if (live.error || !live.updatedAt || (!live.windows.length && !live.identity?.plan && !live.credits && !live.quotaMetrics?.length)) return;
    this.put(identifyFact({ schemaVersion: 1, id: "", kind: "capacity", providerId: provider,
      sourceId: usageSource(replica, provider, account), observedAt: live.updatedAt,
      plan: live.identity?.plan ?? null, credits: live.credits ?? null,
      ...(live.quotaMetrics ? { quotaMetrics: live.quotaMetrics } : {}),
      windows: live.windows.map(w => ({ kind: w.kind, label: w.label, usedPercent: w.usedPercent, resetAt: w.resetAt ?? null })) }));
  }
  pending(): UsageFact[] {
    const rows = this.db.all("SELECT payload FROM usage_fact WHERE owner = ? AND saved = 0 ORDER BY id LIMIT ?", [this.owner(), STATISTICS_BATCH_SIZE]);
    const facts: UsageFact[] = []; let bytes = 0;
    for (const row of rows) {
      const fact = checkFact(JSON.parse(String(row.payload)));
      const size = Buffer.byteLength(JSON.stringify(fact), "utf8");
      if (bytes + size > STATISTICS_MAX_BYTES - 4096) break;
      bytes += size; facts.push(fact);
    }
    if (rows.length && !facts.length) throw new Error("A usage observation is too large to save.");
    return facts;
  }
  acknowledge(ids: string[]): void {
    for (const id of ids) this.db.run("UPDATE usage_fact SET saved = 1 WHERE owner = ? AND id = ?", [this.owner(), id]);
  }
  pendingCount(): number {
    return Number(this.db.get("SELECT COUNT(*) AS count FROM usage_fact WHERE owner IN (?, '') AND saved = 0", [this.owner()])?.count ?? 0);
  }
  /** Pending capacity and collection snapshots. Each provider refresh adds one, with or without new usage. */
  pendingSnapshotCount(): number {
    return Number(this.db.get("SELECT COUNT(*) AS count FROM usage_fact WHERE owner IN (?, '') AND saved = 0 AND kind <> 'usage_event'", [this.owner()])?.count ?? 0);
  }
  /** Deletes pending events that repeat their previous version apart from the pricing catalog revision. */
  async dropRepricedCopies(stopped: () => boolean): Promise<void> {
    const owner = this.owner();
    let after = "";
    while (!stopped()) {
      // Batches as small as the importer's keep each write transaction within other writers' busy timeout.
      const last = this.db.get("SELECT max(id) AS id FROM (SELECT id FROM usage_fact WHERE owner = ? AND saved = 0 AND id > ? ORDER BY id LIMIT ?)",
        [owner, after, STATISTICS_BATCH_SIZE])?.id;
      if (typeof last !== "string") return;
      await this.db.commit([{ sql: `DELETE FROM usage_fact WHERE owner = ?1 AND saved = 0 AND id > ?2 AND id <= ?3
        AND ${repeatsVersion("usage_fact.content_id", "usage_fact.payload", "usage_fact.event_id", "usage_fact.rowid")}`,
      parameters: [owner, after, last] }]);
      after = last;
    }
  }
  hasLocal(): boolean {
    return Boolean(this.db.get("SELECT 1 FROM usage_fact WHERE owner = '' LIMIT 1"));
  }
  async claimLocalBatch(owner: string): Promise<number> {
    if (!owner) throw new Error("Sign in before saving observations.");
    const rows = this.db.all("SELECT rowid FROM usage_fact WHERE owner = '' LIMIT ?", [STATISTICS_BATCH_SIZE]);
    if (!rows.length) return 0;
    const ids = rows.map(row => Number(row.rowid));
    const placeholders = ids.map(() => "?").join(",");
    // Identical facts already owned by the account retain their acknowledgement.
    await this.db.commit([
      { sql: `UPDATE OR IGNORE usage_fact SET owner = ?, saved = 0 WHERE owner = '' AND rowid IN (${placeholders})`, parameters: [owner, ...ids] },
      { sql: `DELETE FROM usage_fact WHERE owner = '' AND rowid IN (${placeholders})`, parameters: ids }
    ]);
    return rows.length;
  }
}

// The models.dev revision hashes every provider's rates and changes almost daily. An event whose
// numbers did not change is not a new version, or each catalog update would copy the whole history.
// content_id ignores that revision and key order. Rows stored before content_id existed compare as
// text: json_set keeps their key order, which matches facts this device collected.
const withoutRepricing = (payload: string) => `json_set(${payload}, '$.id', '', '$.observedAt', '', '$.pricingVersion', NULL)`;
/** Whether a fact repeats the newest version of its event stored below `before` (a rowid), apart from repricing. */
const repeatsVersion = (contentId: string, payload: string, event: string, before?: string) => `EXISTS (SELECT 1 FROM usage_fact p
  WHERE p.rowid = (SELECT v.rowid FROM usage_fact v WHERE v.owner = ?1 AND v.event_id = ${event}${before ? ` AND v.rowid < ${before}` : ""}
    ORDER BY v.rowid DESC LIMIT 1)
  AND (p.content_id = ${contentId} OR ${withoutRepricing("p.payload")} = ${withoutRepricing(payload)}))`;

function insertOperation({ fact: r, contentId }: Fingerprinted, owner: string, saved: boolean): SqliteOperation {
  const event = r.kind === "usage_event" ? r : null;
  return { sql: `INSERT INTO usage_fact (owner,id,source_id,kind,provider,occurred_at,event_id,model,project_id,session_id,payload,saved,content_id)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13
    WHERE NOT ${repeatsVersion("?13", "?11", "?7")}
    ON CONFLICT(owner,id) DO NOTHING`, parameters:
    [owner, r.id, r.sourceId, r.kind, r.providerId, event?.occurredAt ?? r.observedAt,
      event?.eventId ?? null, event?.modelKey ?? null, event?.projectId ?? null, event?.sessionId ?? null,
      JSON.stringify(r), saved ? 1 : 0, contentId] };
}
