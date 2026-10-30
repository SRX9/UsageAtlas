import { afterEach, describe, expect, it } from "vitest";
import { buildAnalytics, type UsageRecord } from "../analytics/local-usage";
import { openWritableSqlite } from "../platform/sqlite";
import { UsageStore } from "./usage-store";
import { UsageSync, type UsageCloud } from "./usage-sync";
import { identifyFact } from "./statistics-store";
import { canReplaceSealed, extractDayPayload } from "./payload";
import { toUsageDay } from "./usage-payload";
import { validateUsageRecord } from "@usageatlas/contracts/usage";
import type { UsageEventFact, UsageFact } from "@usageatlas/contracts/statistics";

const resources: Array<() => void> = [];
afterEach(() => { for (const close of resources.splice(0).reverse()) close(); });
const now = new Date("2026-09-23T12:00:00Z");
function event(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return { timestamp: "2026-09-23T02:00:00Z", day: "2026-09-23", model: "future model / private", reportedModel: "vendor/future-model-2026-09-23",
    sessionID: "private-session", projectPath: "C:/private/project", projectLabel: "private-project", serviceTier: "priority",
    inputTokens: 50, cachedInputTokens: 20, cacheCreationInputTokens: 10, outputTokens: 20, totalTokens: 100,
    estimatedCostUSD: 0.000123456, eventKey: "source-request-1", eventIdentity: "source", rawTokens: { reasoning: 5, cacheWrite1h: 10 }, ...overrides };
}
function analytics(records = [event()]) { return buildAnalytics(records, now, 90, 1, false, "local_sessions", undefined, undefined, "Asia/Calcutta"); }
function store() { const db = openWritableSqlite(":memory:"); resources.push(() => db.close()); const local = new UsageStore(db); local.selectAccount("a"); return local; }
function observe(local: UsageStore, overrides: Partial<UsageRecord>, observedAt?: string): UsageEventFact {
  const a = analytics([event(overrides)]);
  return [...local.statistics.observations("codex", "local", "replica", observedAt ? { ...a, updatedAt: observedAt } : a)][0] as UsageEventFact;
}
/** Stores an event the way rows were stored before content ids existed. */
function insertLegacy(local: UsageStore, value: UsageEventFact) {
  local.db.run("INSERT INTO usage_fact (owner,id,source_id,kind,provider,occurred_at,event_id,payload) VALUES ('a',?,?,?,?,?,?,?)",
    [value.id, value.sourceId, value.kind, value.providerId, value.occurredAt, value.eventId, JSON.stringify(value)]);
}
function day() {
  const a = analytics();
  const payload = extractDayPayload(a, "2026-09-23", { accountKey: "local", windows: [], identity: null, credits: null, source: "local", capturedAt: now.toISOString(), includeCoverageWideBreakdowns: true, timeZone: "Asia/Calcutta" });
  return { payload, record: toUsageDay({ id: "", providerId: "codex", accountKey: "local", localDay: "2026-09-23", sealed: true, changeSeq: 1, updatedAt: now.toISOString(), payload }, "replica", "Asia/Calcutta") };
}

describe("durable usage observations", () => {
  it("retains precise private metadata once across repeated scans, preserving changed observations separately", () => {
    const local = store(); const a = analytics();
    local.statistics.collect("codex", "local", "replica", a);
    local.statistics.collect("codex", "local", "replica", { ...a, updatedAt: "2026-09-23T13:00:00Z" });
    let rows = local.db.all("SELECT payload FROM usage_fact WHERE kind = 'usage_event'");
    expect(rows).toHaveLength(1);
    const fact = JSON.parse(String(rows[0].payload));
    expect(fact).toMatchObject({ modelKey: "future model / private", reportedModel: "vendor/future-model-2026-09-23", rawTokens: { reasoning: 5, cacheWrite1h: 10 }, estimatedCostUSD: 0.000123456 });
    expect(fact.projectId).not.toContain("private");
    expect(JSON.stringify(fact)).not.toContain("C:/private/project");
    local.statistics.collect("codex", "local", "replica", analytics([event({ outputTokens: 21, totalTokens: 101 })]));
    rows = local.db.all("SELECT event_id,payload FROM usage_fact WHERE kind = 'usage_event'");
    expect(rows).toHaveLength(2);
    expect(rows[0].event_id).toBe(rows[1].event_id);
    expect(() => local.statistics.put({ ...fact, totalTokens: 999 })).toThrow();
  });
  it("files a new event version at one blended rate and keeps the cloud replacing the old one", () => {
    const local = store();
    const fact = observe(local, {
      totalTokens: 1_000_000, inputTokens: 600_000, cachedInputTokens: 0,
      cacheCreationInputTokens: 0, outputTokens: 400_000
    });
    local.statistics.put(fact, true);

    expect(local.statistics.reprice(0.54, "2026-09-23T13:00:00Z")).toBe(1);
    const latest = JSON.parse(String(local.db.get("SELECT payload FROM usage_event_latest")?.payload)) as UsageEventFact;
    expect(latest.eventId).toBe(fact.eventId);
    expect(latest.estimatedCostUSD).toBe(0.54);
    expect(latest.totals?.estimatedCostMicrosUSD).toBe(540_000);
    expect(latest.pricingVersion).toBe("blended:0.54");
    expect(local.statistics.pending()).toHaveLength(1);
    expect(local.statistics.reprice(0.54)).toBe(0);
  });

  it("adds an event version when its numbers change, not when only the pricing catalog revision does", () => {
    const local = store();
    const scan = (overrides: Partial<UsageRecord>) => local.statistics.collect("codex", "local", "replica", analytics([event(overrides)]));
    const versions = () => local.db.all("SELECT payload FROM usage_fact WHERE kind = 'usage_event' ORDER BY rowid")
      .map(row => JSON.parse(String(row.payload)) as UsageEventFact).map(fact => [fact.pricingVersion, fact.estimatedCostUSD]);
    scan({ pricingVersion: "catalog-a" });
    scan({ pricingVersion: "catalog-b" });
    expect(versions()).toEqual([["catalog-a", 0.000123456]]);
    scan({ pricingVersion: "catalog-c", estimatedCostUSD: 0.0002 });
    scan({ pricingVersion: "catalog-d", estimatedCostUSD: 0.0002 });
    scan({ pricingVersion: "catalog-e" });
    expect(versions()).toEqual([["catalog-a", 0.000123456], ["catalog-c", 0.0002], ["catalog-e", 0.000123456]]);
  });
  it("adds content ids to an existing ledger and still compares its earlier rows as text", () => {
    const local = store();
    local.statistics.collect("codex", "local", "replica", analytics([event({ pricingVersion: "catalog-a" })]));
    local.db.exec("ALTER TABLE usage_fact DROP COLUMN content_id");
    const reopened = new UsageStore(local.db);
    reopened.statistics.collect("codex", "local", "replica", { ...analytics([event({ pricingVersion: "catalog-b" })]), updatedAt: "2026-09-23T13:00:00Z" });
    expect(local.db.all("SELECT content_id FROM usage_fact WHERE kind = 'usage_event'").map(row => row.content_id)).toEqual([null]);
  });
  it("drops pending catalog-only copies left by earlier versions and keeps changed numbers", async () => {
    const local = store();
    const fact = (overrides: Partial<UsageRecord>) => observe(local, overrides);
    const saved = fact({ pricingVersion: "catalog-a" }); local.statistics.put(saved); local.statistics.acknowledge([saved.id]);
    const changed = fact({ pricingVersion: "catalog-c", estimatedCostUSD: 0.0002 });
    for (const value of [fact({ pricingVersion: "catalog-b" }), changed, fact({ pricingVersion: "catalog-d", estimatedCostUSD: 0.0002 })]) insertLegacy(local, value);
    expect(local.statistics.pendingCount()).toBe(3);
    await local.statistics.dropRepricedCopies(() => false);
    expect(local.statistics.pending().map(value => value.id)).toEqual([changed.id]);
    expect(local.db.all("SELECT 1 FROM usage_fact WHERE saved = 1")).toHaveLength(1);
  });
  it("compares restored facts by their numbers, not by the key order the cloud returns", () => {
    const local = store();
    // Postgres jsonb returns object keys shortest first.
    const jsonb = (value: unknown): unknown => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : 1)).map(([key, item]) => [key, jsonb(item)]))
      : value;
    local.statistics.put(jsonb(observe(local, { pricingVersion: "catalog-a" }, "2026-09-23T12:00:00Z")) as UsageFact, true);
    local.statistics.put(jsonb(observe(local, { pricingVersion: "catalog-b" }, "2026-09-23T12:30:00Z")) as UsageFact, true);
    local.statistics.collect("codex", "local", "replica", { ...analytics([event({ pricingVersion: "catalog-c" })]), updatedAt: "2026-09-23T13:00:00Z" });
    const rows = local.db.all("SELECT payload FROM usage_fact WHERE kind = 'usage_event'");
    expect(rows).toHaveLength(1);
    expect(String(rows[0].payload)).toMatch(/^\{"id":/);
    expect(local.statistics.pending().filter(fact => fact.kind === "usage_event")).toEqual([]);
  });
  it("compares a rescan with the newest observation after a restore adds an older one", () => {
    const local = store();
    const scan = (observedAt: string, overrides: Partial<UsageRecord>) =>
      local.statistics.collect("codex", "local", "replica", { ...analytics([event(overrides)]), updatedAt: observedAt });
    scan("2026-09-23T13:00:00Z", { pricingVersion: "catalog-b", estimatedCostUSD: 0.0002 });
    local.statistics.put(observe(local, { pricingVersion: "catalog-a" }, "2026-09-23T12:00:00Z"), true);
    scan("2026-09-23T14:00:00Z", { pricingVersion: "catalog-c" });
    expect(local.db.all("SELECT json_extract(payload, '$.observedAt') AS observedAt FROM usage_fact WHERE kind = 'usage_event' ORDER BY rowid")
      .map(row => row.observedAt)).toEqual(["2026-09-23T12:00:00Z", "2026-09-23T13:00:00Z", "2026-09-23T14:00:00Z"]);
    expect(JSON.parse(String(local.db.get("SELECT payload FROM usage_event_latest")?.payload)).estimatedCostUSD).toBe(0.000123456);
  });
  it("drops catalog-only copies before a save uploads them, and still uploads when the history writer has stopped", async () => {
    const uploads: string[][] = [];
    const cloud: UsageCloud = {
      async read() { return { records: [], next: null }; }, async save() { return []; },
      async readFacts() { return { facts: [], cursor: "0", more: false }; },
      async saveFacts(facts) { uploads.push(facts.map(fact => fact.id)); return facts.map(fact => fact.id); }
    };
    const backlog = () => {
      const local = store();
      const saved = observe(local, { pricingVersion: "catalog-a" }); local.statistics.put(saved); local.statistics.acknowledge([saved.id]);
      const copy = observe(local, { pricingVersion: "catalog-b" }, "2026-09-23T13:00:00Z");
      const changed = observe(local, { pricingVersion: "catalog-c", estimatedCostUSD: 0.0002 }, "2026-09-23T14:00:00Z");
      for (const value of [copy, changed]) insertLegacy(local, value);
      return { local, copy, changed };
    };
    const save = async (local: UsageStore) => {
      const sync = new UsageSync(local); resources.push(() => sync.close());
      await sync.configure("a", cloud); sync.setAutomatic(false); await sync.save();
    };
    const pruned = backlog(); await save(pruned.local);
    expect(uploads.pop()).toEqual([pruned.changed.id]);
    const stopped = backlog();
    stopped.local.db.commit = async () => { throw new Error("History writer stopped. Refresh usage to retry."); };
    await save(stopped.local);
    expect(uploads.pop()).toEqual([stopped.copy.id, stopped.changed.id].sort());
    expect(stopped.local.statistics.pendingCount()).toBe(0);
  });
  it("keeps unknown measurements as null and exposes no invented zero usage", () => {
    const local = store(); const a = analytics([event({ measurement: "unknown" })]);
    expect(a.status).toBe("partial"); expect(a.recordsProcessed).toBe(0);
    local.statistics.collect("cursor", "account", "replica", a);
    const fact = JSON.parse(String(local.db.get("SELECT payload FROM usage_fact WHERE kind = 'usage_event'")?.payload));
    expect(fact.totals).toBeNull(); expect(fact.measurement).toBe("unknown");
  });
  it("recovers source model labels before saving and resists a later degraded projection", () => {
    const local = store(); const { payload, record } = day();
    const degraded = { ...record, models: [{ modelKey: "other", totals: record.totals! }] };
    const first = local.put(degraded, JSON.stringify(payload));
    expect(first.record).toMatchObject({ models: record.models });
    local.acknowledge(first, { record: first.record, revision: 1 });
    const repeated = local.put(degraded, JSON.stringify(payload));
    expect(repeated.record).toMatchObject({ models: record.models });
    expect(repeated.localVersion).toBe(repeated.savedVersion);
  });
  it("archives replaced detail and keeps compatible detail across model-only cloud updates", () => {
    const local = store(); const { payload, record } = day();
    const row = local.put(record, JSON.stringify(payload)); local.acknowledge(row, { record, revision: 1 });
    local.merge({ record: { ...record, models: [{ ...record.models![0], modelKey: "new-label" }] }, revision: 2 });
    expect(local.get(record.recordId)?.details).toBe(JSON.stringify(payload));
    const changed = { ...record, totals: { ...record.totals!, inputTokens: 150, totalTokens: 200 }, hourly: null, models: null, breakdownCoverage: { hourly: "unknown" as const, models: "unknown" as const } };
    local.merge({ record: changed, revision: 3 });
    expect(local.get(record.recordId)?.details).toBeNull();
    expect(local.db.all("SELECT name FROM sqlite_master WHERE name = 'usage_record_history'")).toEqual([]);
  });
  it("retains sealed history when a successful rescan sees fewer source events", () => {
    const { payload } = day();
    const smaller = { ...payload, totals: { ...payload.totals, totalTokens: 50, inputTokens: 0 } };
    expect(canReplaceSealed(payload, smaller)).toBe(false);
    expect(canReplaceSealed({ ...payload, status: "partial" }, {
      ...smaller, status: "partial", totals: { ...smaller.totals, requests: 2 }
    })).toBe(false);
  });
  it("enforces declared completeness and keeps repeated DST hours separate", () => {
    const { record } = day();
    expect(() => validateUsageRecord({ ...record, models: [] })).toThrow("Complete breakdowns");
    const a = buildAnalytics([event({ timestamp: "2026-11-01T05:30:00Z" }), event({ timestamp: "2026-11-01T06:30:00Z", eventKey: "second" })], new Date("2026-11-01T12:00:00Z"), 1, 1, false, "local_sessions", undefined, undefined, "America/New_York");
    expect(a.hourly?.map(h => [h.hour, h.utcStart])).toEqual([[1, "2026-11-01T05:00:00.000Z"], [1, "2026-11-01T06:00:00.000Z"]]);
  });
  it("retries interrupted uploads, checks acknowledgements, restores facts, and isolates accounts", async () => {
    const local = store(); local.statistics.collect("codex", "local", "replica", analytics());
    const remote = new Map<string, UsageFact>(); let offline = true;
    const cloud: UsageCloud = {
      async read() { return { records: [], next: null }; }, async save() { return []; },
      async readFacts() { return { facts: [...remote.values()], cursor: String(remote.size), more: false }; },
      async saveFacts(facts) { for (const fact of facts) remote.set(fact.id, fact); if (offline) throw new Error("connection lost after commit"); return facts.map(f => f.id); }
    };
    const sync = new UsageSync(local); resources.push(() => sync.close()); await sync.configure("a", cloud); sync.setAutomatic(false);
    await expect(sync.save()).rejects.toThrow("connection lost"); expect(local.statistics.pendingCount()).toBeGreaterThan(0);
    offline = false; await sync.save(); expect(local.statistics.pendingCount()).toBe(0); expect(remote.size).toBe(2);
    const restored = store(); const restore = new UsageSync(restored); resources.push(() => restore.close()); await restore.configure("a", cloud); restore.setAutomatic(false); await restore.restore();
    expect(restored.db.all("SELECT * FROM usage_fact WHERE owner = 'a'")).toHaveLength(0);
    expect(restored.statistics.pending()).toEqual([]);
    await restore.configure("b", { ...cloud, async readFacts() { return { facts: [], cursor: "0", more: false }; } });
    expect(restored.statistics.pending()).toEqual([]);
    expect(restored.db.all("SELECT * FROM usage_fact WHERE owner = 'b'")).toHaveLength(0);
  });
  it("keeps capacity snapshots over time and rejects changed content under an existing fingerprint", () => {
    const local = store(); const live = { source: "oauth", updatedAt: now.toISOString(), analytics: null, identity: { plan: "pro" }, windows: [{ kind: "weekly", label: "Weekly", usedPercent: 10, remainingPercent: 90 }], credits: null };
    local.statistics.capacity("codex", "local", "replica", live);
    local.statistics.capacity("codex", "local", "replica", { ...live, updatedAt: "2026-09-23T13:00:00Z", windows: [{ ...live.windows[0], usedPercent: 20 }] });
    expect(local.db.all("SELECT * FROM usage_fact WHERE kind = 'capacity'")).toHaveLength(1);
    const fact = local.statistics.pending()[0]; expect(identifyFact(fact).id).toBe(fact.id);
    expect(() => local.statistics.put({ ...fact, sourceId: "11111111-1111-4111-a111-111111111111" })).toThrow("fingerprint");
  });
});
