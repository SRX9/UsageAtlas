import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { createFreebuffAdapter } from "./freebuff";
import { FREEBBUFF_MODEL_IDS, freebuffLegacyModelId } from "./freebuff-models";
import { pricingCatalogFromRates } from "../analytics/models-dev";
import { UsageStore } from "../history/usage-store";
import { openWritableSqlite } from "../platform/sqlite";

const now = new Date("2026-10-26T18:00:00Z");
const context = { now, signal: new AbortController().signal, historyDays: 30,
  historyDaysForAccount: () => 30, reportingTimeZoneForAccount: () => "UTC" };

async function desktopFixture(home: string, rows: Array<{ ts: number; metrics: unknown }>): Promise<string> {
  const directory = path.join(home, ".config", "freebuff-desktop", "projects", "app-12345678");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "desktop-v2.db");
  const database = new DatabaseSync(file);
  database.exec(`CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL,
    metrics_json TEXT NOT NULL DEFAULT '{}',
    ts INTEGER NOT NULL
  )`);
  const insert = database.prepare("INSERT INTO messages (thread_id, role, metrics_json, ts) VALUES (?,?,?,?)");
  for (const row of rows) insert.run("thread-1", "assistant", JSON.stringify(row.metrics), row.ts);
  database.close();
  return file;
}

async function joinedFixture(home: string, _model = "m-abc"): Promise<string> {
  const directory = path.join(home, ".config", "freebuff-desktop", "projects", "app-99999999");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "desktop-v2.db");
  const database = new DatabaseSync(file);
  database.exec(`CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL,
    metrics_json TEXT NOT NULL DEFAULT '{}',
    ts INTEGER NOT NULL
  )`);
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, project_path TEXT, model TEXT, sponsored TEXT)");
  database.prepare("INSERT INTO threads (id, project_path, model, sponsored) VALUES (?,?,?,?)")
    .run("thread-1", "C:/work/my-project", _model, "run-1");
  database.prepare("INSERT INTO messages (thread_id, role, metrics_json, ts) VALUES (?,?,?,?)")
    .run("thread-1", "assistant", JSON.stringify({
      usage: { inputTokens: 50, cachedInputTokens: 10, outputTokens: 25, totalTokens: 75 }, costUsd: 0.002
    }), Date.parse("2026-10-26T10:00:00Z"));
  database.close();
  return file;
}

async function writeRoute(cacheFile: string, database: string): Promise<void> {
  const info = await stat(database);
  await mkdir(path.dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, JSON.stringify({ version: 1, resolvedAt: Date.now(), roots: [],
    databases: [{ path: database, size: info.size, mtimeMs: info.mtimeMs }], chats: [] }));
}

async function chatFixture(home: string, messages: unknown[], name = "chat"): Promise<string> {
  const directory = path.join(home, ".config", "manicode", "projects", "app", "chats", name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "chat-messages.json"), JSON.stringify(messages));
  // Availability asks whether the transcript was touched recently, using the real
  // clock, so the fixture's mtime has to be current rather than the frozen `now`.
  await utimes(path.join(directory, "chat-messages.json"), new Date(), new Date());
  return directory;
}

describe("Freebuff local usage", () => {
  it("sums today's provider-reported tokens from the Desktop database", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "usageatlas-freebuff-db-"));
    await desktopFixture(home, [
      { ts: Date.parse("2026-10-26T10:00:00Z"), metrics: { usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, totalTokens: 120 } } },
      { ts: Date.parse("2026-10-26T11:00:00Z"), metrics: { usage: { inputTokens: 10, outputTokens: 5 } } },
      { ts: Date.parse("2026-10-25T23:59:59Z"), metrics: { usage: { inputTokens: 900, outputTokens: 99, totalTokens: 999 } } },
      { ts: Date.parse("2026-10-26T12:00:00Z"), metrics: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } },
      { ts: Date.parse("2026-10-26T13:00:00Z"), metrics: { context: { usedTokens: 50_000, windowTokens: 200_000 } } },
      { ts: Date.parse("2026-10-26T14:00:00Z"), metrics: {} }
    ]);
    const adapter = createFreebuffAdapter({ homeDirectory: home });
    expect(await adapter.isAvailable!()).toBe(true);
    const result = await adapter.refresh(context);
    expect(result.quotaMetrics).toEqual([
      { id: "tokens_today", label: "Tokens used today", unit: "tokens", used: 135, limit: null, remaining: null, resetAt: null },
      { id: "input_tokens_today", label: "Input tokens today", unit: "tokens", used: 70, limit: null, remaining: null, resetAt: null },
      { id: "output_tokens_today", label: "Output tokens today", unit: "tokens", used: 25, limit: null, remaining: null, resetAt: null }
    ]);
    expect(result.windows).toEqual([]);
    // The same rows feed the daily history, so Diagnostics reports a real scan
    // instead of an unread source.
    expect(result.analytics?.status).toBe("available");
    expect(result.analytics?.today).toMatchObject({ totalTokens: 135 });
    expect(result.analytics?.totals).toMatchObject({ inputTokens: 970, cachedInputTokens: 40, outputTokens: 124, totalTokens: 1134, requests: 3 });
  });

  it("reports token categories that reconcile, so local history and the cloud save accept them", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "usageatlas-freebuff-contract-"));
    // Freebuff reports cached tokens inside its input count and a total of its own.
    await desktopFixture(home, [
      { ts: Date.parse("2026-10-26T10:00:00Z"), metrics: {
        usage: { inputTokens: 100, cachedInputTokens: 40, reasoningOutputTokens: 5, outputTokens: 20, totalTokens: 120 }, costUsd: 0 }
      }
    ]);
    const result = await createFreebuffAdapter({ homeDirectory: home }).refresh(context);
    const events = result.analytics?.collection?.events ?? [];
    expect(events).toHaveLength(1);
    // Cached tokens move out of input, so the categories add up to the reported total.
    expect(events[0]).toMatchObject({ inputTokens: 60, cachedInputTokens: 40, outputTokens: 20, totalTokens: 120 });
    const daily = result.analytics!.daily.find((row) => row.date === "2026-10-26")!;
    for (const totals of [events[0], daily]) {
      expect(totals.totalTokens).toBe(
        totals.inputTokens + totals.cachedInputTokens + totals.cacheCreationInputTokens + totals.outputTokens
      );
    }
    // The importer fingerprints every fact before storing it, so the same
    // observation must survive the store that writes local history.
    const db = openWritableSqlite(":memory:");
    try {
      const store = new UsageStore(db);
      store.selectAccount("account");
      expect(() => store.statistics.collect("freebuff", "local", "replica", result.analytics!)).not.toThrow();
      expect(store.statistics.pendingCount()).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("attributes a turn to its thread's model, project and sponsored tier", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "usageatlas-freebuff-join-"));
    await joinedFixture(home);
    const result = await createFreebuffAdapter({ homeDirectory: home }).refresh(context);
    expect(result.analytics?.status).toBe("available");
    expect(result.analytics?.models[0]).toMatchObject({ id: "m-abc" });
    expect(result.analytics?.projects[0]).toMatchObject({ id: "C:/work/my-project", label: "my-project" });
    expect(result.analytics?.sessions[0]).toMatchObject({ id: "thread-1" });
    expect(result.analytics?.serviceTiers[0]).toMatchObject({ id: "sponsored" });
    // Freebuff's own `costUsd` is the subscription's, not an API rate, so a turn
    // without a resolvable price stays unpriced instead of counting as free.
    expect(result.analytics?.totals).toMatchObject({
      inputTokens: 40, cachedInputTokens: 10, outputTokens: 25, totalTokens: 75, requests: 1,
      estimatedCostUSD: null, unpricedTokens: 75
    });
  });

  it("prices a turn from the model hidden behind Freebuff's opaque id", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "usageatlas-freebuff-priced-"));
    await joinedFixture(home, freebuffLegacyModelId("deepseek/deepseek-v4-flash"));
    const catalog = pricingCatalogFromRates({
      // Per token, and the same model is published under another provider key too.
      deepseek: { "deepseek-v4-flash": { input: 1.5e-7, output: 6e-7, cacheRead: 3e-9 } }
    });
    const result = await createFreebuffAdapter({
      homeDirectory: home,
      pricingCatalogLoader: async () => catalog
    }).refresh(context);
    // The opaque id is resolved before pricing, so the row keeps the real name.
    expect(result.analytics?.models[0]).toMatchObject({ id: "deepseek-v4-flash" });
    expect(result.analytics?.collection?.events[0]).toMatchObject({
      model: "deepseek-v4-flash", modelProvider: "deepseek", reportedModel: "m-096e75164d",
      reportedCostUSD: 0.002, pricingVersion: "test"
    });
    // 40 non-cached input, 10 cached, 25 output at the resolved rates.
    expect(result.analytics?.totals.estimatedCostUSD).toBeCloseTo(40 * 1.5e-7 + 10 * 3e-9 + 25 * 6e-7, 12);
    expect(result.analytics?.totals.unpricedTokens).toBe(0);
  });

  it("keeps every id Freebuff ships resolvable", () => {
    expect(Object.keys(FREEBBUFF_MODEL_IDS)).toHaveLength(67);
    expect(freebuffLegacyModelId("deepseek/deepseek-v4-flash")).toBe("m-096e75164d");
  });

  it("buckets database rows in the account's reporting time zone", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "usageatlas-freebuff-tz-"));
    await desktopFixture(home, [
      // 2026-10-26 18:00 UTC is 11:00 in Los Angeles.
      { ts: Date.parse("2026-10-27T02:00:00Z"), metrics: { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } } },
      { ts: Date.parse("2026-10-26T08:00:00Z"), metrics: { usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 } } },
      { ts: Date.parse("2026-10-26T06:59:59Z"), metrics: { usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 } } }
    ]);
    const adapter = createFreebuffAdapter({ homeDirectory: home });
    const result = await adapter.refresh({ ...context, reportingTimeZoneForAccount: () => "America/Los_Angeles" });
    expect(result.quotaMetrics?.[0]).toMatchObject({ id: "tokens_today", used: 12 });
  });

  it("falls back to CLI transcript credits when no Desktop database exists", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "usageatlas-freebuff-chat-"));
    await chatFixture(home, [
      { timestamp: "2026-10-26T12:00:00Z", credits: 2.5 },
      { timestamp: "2026-10-26T06:00:00Z", credits: 1 },
      { timestamp: "2026-10-25T23:59:59Z", credits: 9 },
      { timestamp: "2026-10-26T13:00:00Z", credits: "3" },
      { timestamp: "2026-10-26T13:00:00Z" },
      { timestamp: "not-a-date", credits: 4 }
    ]);
    const adapter = createFreebuffAdapter({ homeDirectory: home });
    expect(await adapter.isAvailable!()).toBe(true);
    const result = await adapter.refresh(context);
    expect(result.quotaMetrics).toEqual([{ id: "credits_today", label: "Credits used today",
      unit: "credits", used: 3.5, limit: null, remaining: null, resetAt: null }]);
    expect(result.windows).toEqual([]);
  });

  it("is unavailable without any source and honours an absolute config override", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "usageatlas-freebuff-empty-"));
    expect(await createFreebuffAdapter({ homeDirectory: empty }).isAvailable!()).toBe(false);

    const custom = await mkdtemp(path.join(tmpdir(), "usageatlas-freebuff-custom-"));
    await mkdir(path.join(custom, "projects", "app", "chats", "chat"), { recursive: true });
    await writeFile(path.join(custom, "projects", "app", "chats", "chat", "chat-messages.json"),
      JSON.stringify([{ timestamp: "2026-10-26T10:00:00Z", credits: 7 }]));
    const adapter = createFreebuffAdapter({ homeDirectory: empty, environment: { FREEBUFF_CONFIG_DIR: custom } });
    expect(await adapter.isAvailable!()).toBe(true);
    expect((await adapter.refresh(context)).quotaMetrics?.[0].used).toBe(7);
  });

  it("reads a Desktop database through FREEBUFF_CONFIG_DIR", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "usageatlas-freebuff-config-db-"));
    await desktopFixture(root, [
      { ts: Date.parse("2026-10-26T10:00:00Z"), metrics: { usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } } }
    ]);
    const adapter = createFreebuffAdapter({ homeDirectory: "/tmp", environment: { FREEBUFF_CONFIG_DIR: path.join(root, ".config", "freebuff-desktop") } });
    expect((await adapter.refresh(context)).quotaMetrics?.[0]).toMatchObject({ id: "tokens_today", used: 10 });
  });

  it("reuses a saved route so a store outside the known folders is still read", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "usageatlas-freebuff-route-hit-"));
    const file = path.join(home, "recorded", "desktop-v2.db");
    await mkdir(path.dirname(file), { recursive: true });
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE messages (role TEXT NOT NULL, metrics_json TEXT NOT NULL, ts INTEGER NOT NULL)");
    database.prepare("INSERT INTO messages (role, metrics_json, ts) VALUES (?,?,?)")
      .run("assistant", JSON.stringify({ usage: { inputTokens: 30, outputTokens: 10 } }), Date.parse("2026-10-26T09:00:00Z"));
    database.close();
    const cacheFile = path.join(home, "user-data", "freebuff-sources.json");
    await writeRoute(cacheFile, file);
    const result = await createFreebuffAdapter({ homeDirectory: home, cacheFile }).refresh(context);
    expect(result.quotaMetrics?.[0]).toMatchObject({ id: "tokens_today", used: 40 });
  });

  it("re-plans and saves a new route when the saved store disappears", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "usageatlas-freebuff-route-miss-"));
    const cacheFile = path.join(home, "user-data", "freebuff-sources.json");
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify({ version: 1, resolvedAt: Date.now(), roots: [], chats: [],
      databases: [{ path: path.join(home, "gone", "desktop-v2.db"), size: 10, mtimeMs: Date.now() }] }));
    const database = await desktopFixture(home, [
      { ts: Date.parse("2026-10-26T09:00:00Z"), metrics: { usage: { inputTokens: 4, outputTokens: 6 } } }
    ]);
    const result = await createFreebuffAdapter({ homeDirectory: home, cacheFile }).refresh(context);
    expect(result.quotaMetrics?.[0]).toMatchObject({ id: "tokens_today", used: 10 });
    const saved = JSON.parse(await readFile(cacheFile, "utf8")) as { databases: Array<{ path: string }> };
    expect(saved.databases.map(entry => entry.path)).toEqual([database]);
  });

  it("rejects a relative config override instead of scanning the working directory", async () => {
    const adapter = createFreebuffAdapter({ homeDirectory: "/tmp", environment: { FREEBUFF_CONFIG_DIR: "relative/path" } });
    expect(await adapter.isAvailable!()).toBe(false);
    await expect(adapter.refresh(context)).rejects.toMatchObject({ code: "config_invalid" });
  });
});
