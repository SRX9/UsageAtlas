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
/**
 * False when a fact's content no longer matches its id, which means the payload
 * was edited after it was fingerprinted.
 */
export function hasValidFingerprint(value: unknown): boolean {
  try {
    checkFact(value);
    return true;
  } catch {
    return false;
  }
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

/**
 * How long a saved observation keeps its payload. Past this, the event is only
 * remembered by its content id, which is all a rescan needs to avoid uploading
 * it a second time. The day record already holds its totals, so a week of
 * request detail is enough to answer "what just ran" without keeping a second
 * full history.
 */
const SAVED_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/** Immutable numeric observations, independently recoverable from display summaries. */
export class StatisticsStore {
  constructor(private readonly db: WritableSqliteDatabase, private readonly owner: () => string) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_event_seen (
        owner TEXT NOT NULL, event_id TEXT NOT NULL, content_id TEXT NOT NULL,
        PRIMARY KEY(owner,event_id,content_id)
      );
      CREATE TABLE IF NOT EXISTS usage_fact (
        owner TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL,
        kind TEXT NOT NULL, provider TEXT NOT NULL, occurred_at TEXT NOT NULL,
        event_id TEXT, model TEXT, project_id TEXT, session_id TEXT,
        payload TEXT NOT NULL, saved INTEGER NOT NULL DEFAULT 0 CHECK (saved IN (0,1)),
        content_id TEXT, reported TEXT,
        PRIMARY KEY(owner,id)
      );
      CREATE INDEX IF NOT EXISTS usage_fact_pending ON usage_fact(owner,id) WHERE saved = 0;
      CREATE INDEX IF NOT EXISTS usage_fact_time ON usage_fact(owner,provider,occurred_at);
      CREATE INDEX IF NOT EXISTS usage_fact_event ON usage_fact(owner,event_id);
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
    if (!db.all("PRAGMA table_info(usage_fact)").some(column => column.name === "reported"))
      db.exec("ALTER TABLE usage_fact ADD COLUMN reported TEXT");
    // Two indexes indexed columns no query in this app filters on, and together
    // they weighed more than the facts they pointed at. The documented view stays
    // the way to read history by model or project.
    db.exec("DROP INDEX IF EXISTS usage_fact_model; DROP INDEX IF EXISTS usage_fact_project");
  }
  /**
   * Keeps the ledger an outbox rather than a second history.
   *
   * `collection` and `capacity` facts are snapshots: only the newest one per
   * source and day (collection) or per source (capacity) can ever be uploaded or
   * shown, and older copies are deleted as soon as a newer one lands. Saved
   * events older than the retention window keep their fingerprint in
   * `usage_event_seen`, so a rescan stays idempotent without its payload.
   */
  compact(now = Date.now()): number {
    const cutoff = new Date(now - SAVED_EVENT_RETENTION_MS).toISOString();
    this.db.run(
      `INSERT OR IGNORE INTO usage_event_seen(owner,event_id,content_id)
       SELECT owner,event_id,content_id FROM usage_fact
       WHERE kind = 'usage_event' AND saved = 1 AND content_id IS NOT NULL AND occurred_at < ?`,
      [cutoff]
    );
    const before = Number(this.db.get("SELECT COUNT(*) AS count FROM usage_fact")?.count ?? 0);
    this.db.run(
      `DELETE FROM usage_fact WHERE kind = 'usage_event' AND saved = 1 AND content_id IS NOT NULL AND occurred_at < ?`,
      [cutoff]
    );
    // Provenance is upload-only: once the server holds a collection or capacity
    // snapshot, keeping a second copy here only grows the local file. A failed
    // save leaves saved = 0, so nothing is lost before it is acknowledged.
    this.db.run("DELETE FROM usage_fact WHERE kind IN ('collection', 'capacity') AND saved = 1");
    this.pruneProvenance();
    const after = Number(this.db.get("SELECT COUNT(*) AS count FROM usage_fact")?.count ?? 0);
    return before - after;
  }
  /** Drops superseded scan and quota snapshots, newest per key wins. */
  private pruneProvenance(): void {
    this.db.run(`DELETE FROM usage_fact WHERE kind = 'collection' AND rowid NOT IN (
      SELECT max(rowid) FROM usage_fact WHERE kind = 'collection'
      GROUP BY owner, provider, source_id, substr(occurred_at, 1, 10))`);
    this.db.run(`DELETE FROM usage_fact WHERE kind = 'capacity' AND rowid NOT IN (
      SELECT max(rowid) FROM usage_fact WHERE kind = 'capacity'
      GROUP BY owner, provider, source_id)`);
  }
  /**
   * Files a repriced version of every event whose stored estimate does not match
   * one blended rate. Each version keeps its event id and gets a fresh
   * observation time, so the cloud replaces the old estimate instead of adding
   * a second request. Returns how many events changed.
   */
  reprice(ratePerMillion: number, observedAt = new Date().toISOString()): number {
    if (!Number.isFinite(ratePerMillion) || ratePerMillion <= 0) return 0;
    const rows = this.db.all(
      `SELECT payload FROM usage_event_latest
       WHERE json_extract(payload, '$.totals.totalTokens') > 0`
    );
    let changed = 0;
    for (const row of rows) {
      let fact: UsageEventFact;
      try {
        fact = JSON.parse(String(row.payload)) as UsageEventFact;
      } catch {
        continue;
      }
      if (!fact.totals) continue;
      const estimatedCostMicrosUSD = Math.round(fact.totals.totalTokens * ratePerMillion);
      const estimatedCostUSD = estimatedCostMicrosUSD / 1_000_000;
      if (fact.totals.estimatedCostMicrosUSD === estimatedCostMicrosUSD
        && fact.totals.unpricedTokens === 0
        && fact.estimatedCostUSD === estimatedCostUSD) continue;
      this.put(identifyFact({
        ...fact,
        id: "",
        observedAt,
        totals: { ...fact.totals, estimatedCostMicrosUSD, unpricedTokens: 0 },
        estimatedCostUSD,
        pricingVersion: `blended:${ratePerMillion}`
      }));
      changed += 1;
    }
    return changed;
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
    if (!inserted?.changes) return null;
    const rowid = Number(inserted.rowid);
    // A newer snapshot replaces its predecessor right away, instead of waiting for
    // the next launch to compact a scan that runs every few minutes.
    if (checked.fact.kind === "collection")
      this.db.run(`DELETE FROM usage_fact WHERE owner = ? AND provider = ? AND source_id = ?
        AND kind = 'collection' AND substr(occurred_at, 1, 10) = substr(?, 1, 10)
        AND rowid <> ? AND occurred_at <= ?`, [owner, checked.fact.providerId, checked.fact.sourceId,
        checked.fact.observedAt, rowid, checked.fact.observedAt]);
    else if (checked.fact.kind === "capacity")
      this.db.run(`DELETE FROM usage_fact WHERE owner = ? AND provider = ? AND source_id = ?
        AND kind = 'capacity' AND rowid <> ? AND occurred_at <= ?`, [owner, checked.fact.providerId,
        checked.fact.sourceId, rowid, checked.fact.observedAt]);
    return rowid;
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
  /**
   * Pending observations, optionally limited to providers the server accepts.
   * Narrowing the query rather than filtering the batch keeps one unsupported
   * source from hiding the sources that can be saved.
   */
  pending(providers?: readonly string[]): UsageFact[] {
    // An explicitly empty scope means nothing is uploadable, not everything.
    if (providers && !providers.length) return [];
    const scope = providers ? ` AND provider IN (${providers.map(() => "?").join(",")})` : "";
    const rows = this.db.all(
      `SELECT payload FROM usage_fact WHERE owner = ? AND saved = 0${scope} ORDER BY id LIMIT ?`,
      [this.owner(), ...(providers ?? []), STATISTICS_BATCH_SIZE]
    );
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
  pendingCount(providers?: readonly string[]): number {
    // An explicitly empty scope means nothing is uploadable, not everything.
    if (providers && !providers.length) return 0;
    const scope = providers ? ` AND provider IN (${providers.map(() => "?").join(",")})` : "";
    return Number(this.db.get(
      `SELECT COUNT(*) AS count FROM usage_fact WHERE owner IN (?, '') AND saved = 0${scope}`,
      [this.owner(), ...(providers ?? [])]
    )?.count ?? 0);
  }
  /** Providers of the observations still waiting to be saved, in stable order. */
  pendingProviders(): string[] {
    return this.db
      .all("SELECT DISTINCT provider FROM usage_fact WHERE owner IN (?, '') AND saved = 0 ORDER BY provider", [this.owner()])
      .map((row) => String(row.provider));
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
const repeatsVersion = (contentId: string, payload: string, event: string, before?: string) => `(
  EXISTS (SELECT 1 FROM usage_fact p
    WHERE p.rowid = (SELECT v.rowid FROM usage_fact v WHERE v.owner = ?1 AND v.event_id = ${event}${before ? ` AND v.rowid < ${before}` : ""}
      ORDER BY v.rowid DESC LIMIT 1)
    AND (p.content_id = ${contentId} OR ${withoutRepricing("p.payload")} = ${withoutRepricing(payload)}))
  OR EXISTS (SELECT 1 FROM usage_event_seen m
    WHERE m.owner = ?1 AND m.event_id = ${event} AND m.content_id = ${contentId}))`;

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
