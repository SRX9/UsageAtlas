import { afterEach, describe, expect, it } from "vitest";
import { openWritableSqlite } from "../platform/sqlite";
import { UsageStore } from "./usage-store";
import {
  validateUsageRecord,
  type UsageDay,
  type UsageProvider
} from "@usageatlas/contracts/usage";
import fixtures from "@usageatlas/contracts/fixtures/usage-record-v1.json";

const resources: Array<() => void> = [];
afterEach(() => {
  for (const close of resources.splice(0).reverse()) close();
});

function openStore() {
  const db = openWritableSqlite(":memory:");
  resources.push(() => db.close());
  return new UsageStore(db);
}

function day(tokens: number, providerId: UsageProvider = "freebuff"): UsageDay {
  const record = structuredClone(fixtures[0]) as UsageDay;
  record.providerId = providerId;
  record.hourly = null;
  record.models = null;
  record.totals = {
    inputTokens: tokens,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    totalTokens: tokens,
    requests: 1,
    estimatedCostMicrosUSD: null,
    unpricedTokens: tokens
  };
  return validateUsageRecord(record) as UsageDay;
}

/** A day whose model breakdown carries the whole daily total, like a real local record. */
function withModel(record: UsageDay): UsageDay {
  return { ...record, models: [{ modelKey: "deepseek-v4-flash", totals: record.totals! }] };
}

describe("records an older build left invalid", () => {
  it("drops the unreadable cloud copy and makes the local record uploadable again", () => {
    const store = openStore();
    store.selectAccount("a");
    const local = day(100);
    store.put(local);
    // Exactly what the buggy merge stored: local model totals (200) on a 100-token day.
    const hybrid = { ...day(100, "codex"), recordId: local.recordId, models: withModel(day(200)).models };
    expect(() => validateUsageRecord(hybrid)).toThrow("Breakdowns exceed daily usage.");
    store.db.run("UPDATE usage_record SET conflict = ?, save_error = ? WHERE id = ?", [
      JSON.stringify({ record: hybrid, revision: 1 }),
      "Invalid local usage record",
      local.recordId
    ]);
    // Reading no longer loses the row to its unreadable cloud copy…
    expect(store.records().map(row => row.record.recordId)).toEqual([local.recordId]);
    // …but it stays out of the next save until the stale flag is cleared.
    expect(store.counts().invalid).toBe(1);
    expect(store.pending()).toEqual([]);

    const reopened = new UsageStore(store.db);

    expect(reopened.get(local.recordId)?.conflict).toBeNull();
    expect(reopened.counts().invalid).toBe(0);
    expect(reopened.records().map(row => row.record.recordId)).toEqual([local.recordId]);
    expect(reopened.pending().map(row => row.record.recordId)).toEqual([local.recordId]);
  });

  it("keeps a record whose own payload is unreadable flagged for recovery", () => {
    const store = openStore();
    store.selectAccount("a");
    const local = day(100);
    store.put(local);
    store.db.run("UPDATE usage_record SET payload = ?, save_error = ? WHERE id = ?", [
      "{not-json",
      "Invalid local usage record",
      local.recordId
    ]);

    const reopened = new UsageStore(store.db);

    expect(reopened.get(local.recordId)).toBeNull();
    expect(reopened.counts().invalid).toBe(1);
    expect(reopened.pending()).toEqual([]);
  });

});
