import { afterEach, describe, expect, it } from "vitest";
import { buildAnalytics, type UsageRecord } from "../analytics/local-usage";
import { openWritableSqlite } from "../platform/sqlite";
import { UsageStore } from "./usage-store";
import { identifyFact } from "./statistics-store";
import type { UsageEventFact } from "@usageatlas/contracts/statistics";
import { validateUsageRecord, type UsageDay } from "@usageatlas/contracts/usage";
import { deflateRawSync } from "node:zlib";
import fixtures from "@usageatlas/contracts/fixtures/usage-record-v1.json";

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const database of opened.splice(0)) await database.close();
});

function database() {
  const db = openWritableSqlite(":memory:");
  opened.push(db);
  return db;
}

function event(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    timestamp: "2026-09-23T02:00:00Z",
    day: "2026-09-23",
    model: "gpt-5.3-codex",
    sessionID: "session",
    projectPath: "C:/project",
    projectLabel: "project",
    serviceTier: "default",
    inputTokens: 50,
    cachedInputTokens: 20,
    cacheCreationInputTokens: 10,
    outputTokens: 20,
    totalTokens: 100,
    estimatedCostUSD: 0.0001,
    eventKey: "request-1",
    ...overrides
  };
}

function analytics(updatedAt = "2026-09-23T12:00:00Z") {
  return buildAnalytics([event()], new Date(updatedAt), 90, 1, false, "local_sessions", undefined, undefined, "UTC");
}

describe("compact local ledger", () => {
  it("no longer creates the write-only archive table", () => {
    const db = database();
    new UsageStore(db);
    expect(db.all("SELECT name FROM sqlite_master WHERE name = 'usage_record_history'")).toEqual([]);
  });

  it("keeps one collection fact per source and day instead of one per scan", () => {
    const db = database();
    const store = new UsageStore(db);
    for (const hour of ["2026-09-23T10:00:00Z", "2026-09-23T11:00:00Z", "2026-09-23T12:00:00Z"]) {
      store.statistics.collect("codex", "local", "replica", analytics(hour));
    }
    const rows = db.all("SELECT kind, occurred_at FROM usage_fact WHERE kind = 'collection'");
    expect(rows).toHaveLength(1);
    expect(rows[0].occurred_at).toBe("2026-09-23T12:00:00.000Z");
  });

  it("keeps only the newest capacity snapshot per source", () => {
    const db = database();
    const store = new UsageStore(db);
    const live = {
      source: "local_sessions" as const,
      updatedAt: "2026-09-23T10:00:00Z",
      analytics: null,
      identity: { plan: "pro" },
      windows: [{ kind: "weekly" as const, label: "Weekly", usedPercent: 10, remainingPercent: 90 }],
      credits: null
    };
    store.statistics.capacity("codex", "local", "replica", live);
    store.statistics.capacity("codex", "local", "replica", { ...live, updatedAt: "2026-09-23T11:00:00Z" });
    const rows = db.all("SELECT occurred_at FROM usage_fact WHERE kind = 'capacity'");
    expect(rows).toEqual([{ occurred_at: "2026-09-23T11:00:00Z" }]);
  });

  it("stores a day's display detail as plain JSON, the format the user asked to keep", () => {
    const db = database();
    const store = new UsageStore(db);
    const details = JSON.stringify({
      models: Array.from({ length: 80 }, (_, index) => ({ id: `model-${index}`, label: `Model ${index}`, totalTokens: 1_234 })),
      hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, totalTokens: 4_321 }))
    });
    const day: UsageDay = {
      schemaVersion: 1,
      recordId: "22222222-2222-4222-8222-222222222222",
      sourceId: "11111111-1111-4111-8111-111111111111",
      providerId: "codex",
      kind: "usage_day",
      observedAt: "2026-09-23T12:00:00.000Z",
      localDay: "2026-09-23",
      timeZone: "UTC",
      dayState: "complete",
      collectionMethod: "local_activity",
      status: "available",
      totals: { inputTokens: 10, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 10, totalTokens: 20, requests: 1, estimatedCostMicrosUSD: 0, unpricedTokens: 0 },
      hourly: null,
      models: null
    };
    const stored = store.put(day, details);

    const raw = String(db.get("SELECT details FROM usage_record WHERE id = ?", [day.recordId])?.details);
    expect(raw).toBe(details);
    expect(raw.startsWith("z1:")).toBe(false);
    expect(store.get(day.recordId)?.details).toBe(details);
    expect(stored.details).toBe(details);
  });

  it("expands a detail compressed by 0.4.1 on the next launch", () => {
    const db = database();
    const store = new UsageStore(db);
    const record = validateUsageRecord(structuredClone(fixtures[0])) as UsageDay;
    store.put(record, JSON.stringify({ totals: record.totals }));
    const details = JSON.stringify({ models: Array.from({ length: 80 }, (_, index) => ({ id: `model-${index}`, totalTokens: index })) });
    const compressed = `z1:${deflateRawSync(details, { level: 9 }).toString("base64")}`;
    db.run("UPDATE usage_record SET details = ? WHERE id = ?", [compressed, record.recordId]);

    new UsageStore(db);
    expect(String(db.get("SELECT details FROM usage_record WHERE id = ?", [record.recordId])?.details)).toBe(details);
  });

  it("reprices stored days and their details to a blended rate", () => {
    const db = database();
    const store = new UsageStore(db);
    const totals = { inputTokens: 600_000, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 400_000, totalTokens: 1_000_000, requests: 2, estimatedCostMicrosUSD: 5_000_000, unpricedTokens: 0 };
    const day: UsageDay = {
      schemaVersion: 1,
      recordId: "33333333-3333-4333-8333-333333333333",
      sourceId: "11111111-1111-4111-8111-111111111111",
      providerId: "freebuff",
      kind: "usage_day",
      observedAt: "2026-09-23T12:00:00.000Z",
      localDay: "2026-09-23",
      timeZone: "UTC",
      dayState: "complete",
      collectionMethod: "local_activity",
      status: "available",
      totals,
      hourly: [{ localHour: 2, utcStart: null, totals }],
      models: [{ modelKey: "m-123", totals }]
    };
    const details = JSON.stringify({ totals, models: [{ modelKey: "m-123", totals }] });
    store.put(day, details);

    expect(store.repriceDayCosts(0.54)).toBe(1);
    const repriced = store.get(day.recordId)!.record as UsageDay;
    expect(repriced.totals?.estimatedCostMicrosUSD).toBe(540_000);
    expect(repriced.hourly?.[0].totals.estimatedCostMicrosUSD).toBe(540_000);
    expect(repriced.models?.[0].totals.estimatedCostMicrosUSD).toBe(540_000);
    expect(JSON.parse(store.get(day.recordId)!.details!).models[0].totals.estimatedCostMicrosUSD).toBe(540_000);
    // A second pass has nothing left to write.
    expect(store.repriceDayCosts(0.54)).toBe(0);
  });

  it("drops provenance the server already holds", () => {
    const db = database();
    const store = new UsageStore(db);
    store.selectAccount("a");
    const facts = [...store.statistics.observations("codex", "local", "replica", analytics())];
    for (const fact of facts) store.statistics.put(fact, true);
    expect(facts.some(fact => fact.kind === "collection")).toBe(true);
    expect(db.all("SELECT id FROM usage_fact WHERE kind = 'collection'")).toHaveLength(1);

    store.statistics.compact();
    expect(db.all("SELECT id FROM usage_fact WHERE kind IN ('collection', 'capacity')")).toEqual([]);
  });

  it("keeps an attribution label on the row it names instead of a settings row", () => {
    const db = database();
    const store = new UsageStore(db);
    const fact = [...store.statistics.observations("codex", "local", "replica", analytics())][0] as UsageEventFact;
    store.statistics.put(fact);
    store.setAttribution(`fact:${fact.id}`, "codex|gpt-5.3-codex");
    expect(store.attribution(`fact:${fact.id}`)).toBe("codex|gpt-5.3-codex");
    expect(db.get("SELECT reported FROM usage_fact WHERE id = ?", [fact.id])?.reported).toBe("codex|gpt-5.3-codex");

    const record = validateUsageRecord(structuredClone(fixtures[0])) as UsageDay;
    store.put(record);
    store.setAttribution(`record:${record.recordId}`, "claude|claude-opus-5");
    expect(store.attribution(`record:${record.recordId}`)).toBe("claude|claude-opus-5");
    expect(db.get("SELECT reported FROM usage_record WHERE id = ?", [record.recordId])?.reported).toBe("claude|claude-opus-5");
    expect(db.all("SELECT key FROM usage_setting WHERE key LIKE 'attribution:%'")).toEqual([]);
  });

  it("moves labels written by earlier builds onto their rows", () => {
    const db = database();
    const store = new UsageStore(db);
    const fact = [...store.statistics.observations("codex", "local", "replica", analytics())][0] as UsageEventFact;
    store.statistics.put(fact);
    // What 0.4.x wrote: one settings row per labelled fact.
    store.setSetting(`attribution:fact:${fact.id}`, "claude|claude-opus-5");
    db.run("DELETE FROM usage_setting WHERE key = 'attribution-columns'");

    const reopened = new UsageStore(db);
    expect(reopened.attribution(`fact:${fact.id}`)).toBe("claude|claude-opus-5");
    expect(db.all("SELECT key FROM usage_setting WHERE key LIKE 'attribution:%'")).toEqual([]);
  });

  it("drops saved events past the window but remembers their content", () => {
    const db = database();
    const store = new UsageStore(db);
    store.selectAccount("a");
    const fact = [...store.statistics.observations("codex", "local", "replica", analytics())][0] as UsageEventFact;
    store.statistics.put(fact, true);
    db.run("UPDATE usage_fact SET occurred_at = '2026-01-01T00:00:00Z' WHERE id = ?", [fact.id]);

    expect(store.statistics.compact(new Date("2026-09-23T12:00:00Z").getTime())).toBe(1);
    expect(db.all("SELECT id FROM usage_fact WHERE kind = 'usage_event'")).toEqual([]);
    expect(db.get("SELECT COUNT(*) AS count FROM usage_event_seen")?.count).toBe(1);

    // The same observation seen again is not stored or uploaded a second time.
    store.statistics.put(fact);
    expect(db.all("SELECT id FROM usage_fact WHERE kind = 'usage_event'")).toEqual([]);
    expect(store.statistics.pending()).toEqual([]);
    expect(identifyFact(fact).id).toBe(fact.id);
  });
});
