import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildAnalytics, type UsageRecord } from "../analytics/local-usage";
import { EngineService } from "../engine-service";
import { SqliteHistoryStore } from "./sqlite-store";
import { UsageSync } from "./usage-sync";
import { HISTORY_BACKFILL_DAYS, historyDaysForAccount } from "./seal";

const now = new Date("2026-09-24T12:00:00Z");
const resources: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); vi.useRealTimers(); });
function analytics(count = 701) {
  const records: UsageRecord[] = Array.from({ length: count }, (_, i) => ({
    timestamp: now.toISOString(), day: "2026-09-24", model: "gpt-5", sessionID: "s",
    projectPath: null, projectLabel: "Unknown project", serviceTier: "standard",
    inputTokens: 10, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 2,
    totalTokens: 12, estimatedCostUSD: null, eventKey: `event-${i}`, eventIdentity: "source"
  }));
  return buildAnalytics(records, now, 90, 1, false, "local_sessions", undefined, undefined, "UTC");
}
function store(filename = ":memory:") {
  const history = SqliteHistoryStore.open(filename); resources.push(() => history.close()); return history;
}
const count = (history: SqliteHistoryStore, owner = "") => Number(history.usage.db.get(
  "SELECT count(*) AS n FROM usage_fact WHERE kind = 'usage_event' AND owner = ?", [owner])?.n);
const wait = (history: SqliteHistoryStore, owner = history.usage.owner) => history.imports.wait(owner, new AbortController().signal);

describe("background local history imports", () => {
  it("returns a snapshot before writing observations, then commits bounded batches", async () => {
    vi.useFakeTimers();
    const history = store();
    history.usage.setSetting("reporting-timezone", "UTC");
    const engine = new EngineService([{ id: "codex", name: "Codex", refresh: async () => ({
      source: "local", windows: [], identity: null, credits: null, updatedAt: now.toISOString(),
      error: null, analytics: analytics(), accountKey: "local"
    }) }], () => now, history);
    const response = await engine.handle({ id: "snapshot", method: "snapshot.get", params: { force: true } });
    expect(response.ok).toBe(true);
    expect(history.get("codex", "local", "2026-09-24")?.payload.totals.totalTokens).toBe(701 * 12);
    expect(count(history)).toBe(0);
    expect(history.imports.status()).toMatchObject({ completed: 0, total: 701 });
    const commit = history.usage.db.commit.bind(history.usage.db);
    const firstBatch = vi.spyOn(history.usage.db, "commit").mockImplementation(async operations => {
      await commit(operations); history.imports.pause();
    });
    await vi.advanceTimersToNextTimerAsync();
    expect(count(history)).toBe(250);
    expect(history.imports.status()).toMatchObject({ completed: 250, total: 701 });
    firstBatch.mockRestore(); history.imports.resume();
    const finished = wait(history);
    await vi.runAllTimersAsync(); await finished;
    expect(count(history)).toBe(701);
    expect(history.imports.status()).toBeNull();
    expect(history.usage.db.all("SELECT id FROM usage_fact WHERE kind = 'collection'")).toHaveLength(1);
  });

  it("answers engine requests while a durable batch is still waiting on storage", async () => {
    vi.useFakeTimers(); const history = store();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const original = history.usage.db.commit.bind(history.usage.db);
    const commit = vi.spyOn(history.usage.db, "commit").mockImplementation(async operations => {
      await gate; await original(operations);
    });
    history.saveCollection("codex", "local", analytics());
    await vi.advanceTimersToNextTimerAsync();
    expect(commit).toHaveBeenCalledOnce(); expect(count(history)).toBe(0);
    const engine = new EngineService([], () => now, history);
    expect((await engine.handle({ id: "status", method: "cloud", params: { operation: "status" } })).ok).toBe(true);
    expect((await engine.handle({ id: "snapshot", method: "snapshot.get", params: { hydrateOnly: true } })).ok).toBe(true);
    finish(); await vi.runAllTimersAsync(); expect(count(history)).toBe(701);
  });

  it("defers all observation batches until every provider scan has finished", async () => {
    vi.useFakeTimers(); const history = store();
    history.usage.setSetting("reporting-timezone", "UTC");
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const result = () => ({ source: "local" as const, windows: [], identity: null, credits: null,
      updatedAt: now.toISOString(), error: null, analytics: analytics(), accountKey: "local" });
    const engine = new EngineService([
      { id: "claude", name: "Claude", refresh: async () => result() },
      { id: "codex", name: "Codex", refresh: async () => { await gate; return result(); } }
    ], () => now, history);
    const snapshot = engine.handle({ id: "snapshot", method: "snapshot.get", params: { force: true } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(history.imports.status()).not.toBeNull(); expect(count(history)).toBe(0);
    finish(); expect((await snapshot).ok).toBe(true); expect(count(history)).toBe(0);
    await vi.runAllTimersAsync(); expect(count(history)).toBe(1402);
  });

  it("coalesces waiting scans without clearing the newest recovery marker early", async () => {
    vi.useFakeTimers(); const history = store();
    const commit = history.usage.db.commit.bind(history.usage.db);
    const firstCollection = vi.spyOn(history.usage.db, "commit").mockImplementation(async operations => {
      await commit(operations);
      if (operations.some(operation => operation.sql.startsWith("DELETE FROM usage_setting"))) history.imports.pause();
    });
    history.saveCollection("codex", "local", analytics());
    history.saveCollection("codex", "local", analytics(702));
    history.saveCollection("codex", "local", analytics(703));
    await vi.runAllTimersAsync();
    expect(count(history)).toBe(701);
    expect(history.imports.needsBackfill("codex", "local")).toBe(true);
    firstCollection.mockRestore(); history.imports.resume();
    const finished = wait(history); await vi.runAllTimersAsync(); await finished;
    expect(count(history)).toBe(703);
    expect(history.usage.db.all("SELECT id FROM usage_fact WHERE kind = 'collection'")).toHaveLength(2);
    expect(history.imports.needsBackfill("codex", "local")).toBe(false);
  });

  it("claims anonymous observations in cancellable batches for the original account", async () => {
    vi.useFakeTimers(); const history = store();
    history.saveCollection("codex", "local", analytics()); await vi.runAllTimersAsync();
    const saveFacts = vi.fn(async (facts: { id: string }[]) => facts.map(fact => fact.id));
    const sync = new UsageSync(history.usage); resources.push(() => sync.close());
    await sync.configure("a", { read: async () => ({records: [], next: null}), save: async () => [], saveFacts });
    const saving = sync.save();
    expect(count(history, "a")).toBeGreaterThan(0);
    expect(count(history, "a")).toBeLessThanOrEqual(250);
    const switching = sync.configure("b", null);
    await vi.runAllTimersAsync(); await switching; await saving;
    expect(saveFacts).not.toHaveBeenCalled();
    expect(count(history, "a")).toBeLessThanOrEqual(250);
    expect(count(history, "b")).toBe(0);
    expect(count(history) + count(history, "a")).toBe(701);
  });

  it("keeps the captured account owner when switching between import batches", async () => {
    vi.useFakeTimers(); const history = store();
    history.usage.selectAccount("a"); history.saveCollection("codex", "local", analytics());
    await vi.advanceTimersToNextTimerAsync();
    history.usage.selectAccount("b");
    expect(history.imports.status()).toBeNull();
    await vi.runAllTimersAsync();
    expect(count(history, "a")).toBe(701); expect(count(history, "b")).toBe(0);
  });

  it("reopens committed batches, requests a full rescan, and resumes without duplicates", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "usageatlas-import-"));
    resources.push(() => rmSync(folder, { recursive: true, force: true }));
    const file = path.join(folder, "history.sqlite");
    const first = SqliteHistoryStore.open(file);
    const commit = first.usage.db.commit.bind(first.usage.db);
    vi.spyOn(first.usage.db, "commit").mockImplementation(async operations => {
      await commit(operations); first.imports.pause();
    });
    first.saveCollection("cursor", "account", analytics());
    await vi.waitFor(() => expect(count(first)).toBe(250)); await first.close();
    const resumed = store(file);
    expect(historyDaysForAccount(resumed, "cursor", "account", now)).toBe(HISTORY_BACKFILL_DAYS);
    await expect(wait(resumed)).rejects.toThrow("Refresh usage");
    resumed.saveCollection("cursor", "account", analytics());
    await wait(resumed);
    expect(count(resumed)).toBe(701); expect(resumed.imports.needsBackfill("cursor", "account")).toBe(false);
  });

  it("does not publish a completed collection after a rolled-back batch and retries on refresh", async () => {
    vi.useFakeTimers(); const history = store();
    const original = history.usage.db.commit.bind(history.usage.db);
    const put = vi.spyOn(history.usage.db, "commit");
    let calls = 0;
    put.mockImplementation(operations => original(++calls === 2
      ? [...operations.slice(0, 49), { sql: "INSERT INTO missing_history_table VALUES (1)", parameters: [] }]
      : operations));
    history.saveCollection("codex", "local", analytics());
    await vi.runAllTimersAsync();
    expect(count(history)).toBe(250);
    expect(history.usage.db.all("SELECT id FROM usage_fact WHERE kind = 'collection'")).toHaveLength(0);
    await expect(wait(history)).rejects.toThrow("could not be stored");
    put.mockRestore(); history.saveCollection("codex", "local", analytics());
    const finished = wait(history); await vi.runAllTimersAsync(); await finished;
    expect(count(history)).toBe(701);
  });

  it("waits for local imports before cloud upload and cancels that wait on sign-out", async () => {
    vi.useFakeTimers(); const history = store(); history.usage.selectAccount("a");
    const read = vi.fn(async () => ({ records: [], next: null }));
    const saveFacts = vi.fn(async (facts: { id: string }[]) => facts.map(fact => fact.id));
    const sync = new UsageSync(history.usage, undefined, signal => history.imports.wait(history.usage.owner, signal));
    resources.push(() => sync.close());
    await sync.configure("a", { read, save: async () => [], saveFacts });
    history.saveCollection("codex", "local", analytics());
    const saving = sync.save();
    await Promise.resolve(); expect(read).not.toHaveBeenCalled();
    await sync.configure("", null); await saving;
    expect(sync.status()).toMatchObject({ busy: false, accountId: null, lastCompleted: null });
    expect(saveFacts).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    await sync.configure("a", { read, save: async () => [], saveFacts });
    await sync.save();
    expect(saveFacts.mock.calls.flatMap(call => call[0])).toHaveLength(702);
    expect(sync.status()).toMatchObject({ lastCompleted: "save", pending: 0 });
  });
});
