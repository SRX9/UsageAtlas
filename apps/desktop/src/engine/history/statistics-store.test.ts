import { afterEach, describe, expect, it } from "vitest";
import { buildAnalytics, type UsageRecord } from "../analytics/local-usage";
import { openWritableSqlite } from "../platform/sqlite";
import { UsageStore } from "./usage-store";
import { UsageSync, type UsageCloud } from "./usage-sync";
import { identifyFact } from "./statistics-store";
import { canReplaceSealed, extractDayPayload } from "./payload";
import { toUsageDay } from "./usage-payload";
import { validateUsageRecord } from "@usageatlas/contracts/usage";
import type { UsageFact } from "@usageatlas/contracts/statistics";

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
    expect(local.db.all("SELECT details FROM usage_record_history WHERE details IS NOT NULL").length).toBeGreaterThan(0);
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
    expect(restored.db.all("SELECT * FROM usage_fact WHERE owner = 'a'")).toHaveLength(2);
    await restore.configure("b", { ...cloud, async readFacts() { return { facts: [], cursor: "0", more: false }; } });
    expect(restored.statistics.pending()).toEqual([]);
    expect(restored.db.all("SELECT * FROM usage_fact WHERE owner = 'b'")).toHaveLength(0);
  });
  it("keeps capacity snapshots over time and rejects changed content under an existing fingerprint", () => {
    const local = store(); const live = { source: "oauth", updatedAt: now.toISOString(), analytics: null, identity: { plan: "pro" }, windows: [{ kind: "weekly", label: "Weekly", usedPercent: 10, remainingPercent: 90 }], credits: null };
    local.statistics.capacity("codex", "local", "replica", live);
    local.statistics.capacity("codex", "local", "replica", { ...live, updatedAt: "2026-09-23T13:00:00Z", windows: [{ ...live.windows[0], usedPercent: 20 }] });
    expect(local.db.all("SELECT * FROM usage_fact WHERE kind = 'capacity'")).toHaveLength(2);
    const fact = local.statistics.pending()[0]; expect(identifyFact(fact).id).toBe(fact.id);
    expect(() => local.statistics.put({ ...fact, sourceId: "11111111-1111-4111-a111-111111111111" })).toThrow("fingerprint");
  });
});
