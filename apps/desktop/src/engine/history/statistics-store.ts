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
  const parsed = validateUsageFact(fact);
  if (createHash("sha256").update(factContent(parsed)).digest("hex") !== parsed.id) throw new Error("Usage observation fingerprint does not match.");
  return parsed;
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
  }
  put(fact: UsageFact, saved = false, owner = this.owner()): void {
    this.insert(checkFact(fact), saved, owner);
  }
  private insert(r: UsageFact, saved: boolean, owner: string): void {
    const operation = insertOperation(r, owner, saved);
    this.db.run(operation.sql, operation.parameters);
    if (saved) this.db.run("UPDATE usage_fact SET saved = 1 WHERE owner = ? AND id = ?", [owner, r.id]);
  }
  async putBatch(facts: UsageFact[], owner: string, completion?: { key: string; version: string }): Promise<void> {
    const operations = facts.map(fact => insertOperation(checkFact(fact), owner, false));
    if (completion) operations.push({ sql: "DELETE FROM usage_setting WHERE key = ? AND value = ?", parameters: [completion.key, completion.version] });
    await this.db.commit(operations);
  }
  collect(provider: UsageProvider, account: string, replica: string, analytics: LocalUsageAnalytics): void {
    const owner = this.owner();
    for (const fact of this.observations(provider, account, replica, analytics)) this.insert(fact, false, owner);
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
    if (live.error || !live.updatedAt || (!live.windows.length && !live.identity?.plan && !live.credits)) return;
    this.put(identifyFact({ schemaVersion: 1, id: "", kind: "capacity", providerId: provider,
      sourceId: usageSource(replica, provider, account), observedAt: live.updatedAt,
      plan: live.identity?.plan ?? null, credits: live.credits ?? null,
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

function insertOperation(r: UsageFact, owner: string, saved: boolean): SqliteOperation {
  const event = r.kind === "usage_event" ? r : null;
  return { sql: `INSERT INTO usage_fact (owner,id,source_id,kind,provider,occurred_at,event_id,model,project_id,session_id,payload,saved)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,id) DO NOTHING`, parameters:
    [owner, r.id, r.sourceId, r.kind, r.providerId, event?.occurredAt ?? r.observedAt,
      event?.eventId ?? null, event?.modelKey ?? null, event?.projectId ?? null, event?.sessionId ?? null,
      JSON.stringify(r), saved ? 1 : 0] };
}
