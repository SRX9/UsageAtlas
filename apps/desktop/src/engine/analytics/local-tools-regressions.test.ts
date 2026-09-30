import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, expect, it } from "vitest";
import { JsonSessionUsageScanner, piSessionParser } from "./pi-muse-usage";
import { SessionFileCache, sessionAnalytics } from "./session-source";
import { AntigravityUsageScanner, antigravityRoots } from "./antigravity-usage";
import { openWritableSqlite } from "../platform/sqlite";
import { UsageStore } from "../history/usage-store";
import { pricingCatalogFromRates } from "./models-dev";

import { buildAntigravityTestWorker } from "./antigravity-test-worker";

const dirs: string[] = [];
let workerPath: string;
beforeAll(async () => { workerPath = await buildAntigravityTestWorker(); });
const now = new Date("2026-09-27T12:00:00Z");
const context = () => ({ now, historyDays: 90, timeZone: "UTC", signal: new AbortController().signal });
async function home() { const d = await mkdtemp(path.join(tmpdir(), "provider-review-")); dirs.push(d); return d; }
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function jsonl(file: string, rows: unknown[]) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
}
function muse(id: string, kind = "model_completed", usage = { input_tokens: 100, output_tokens: 25 }) {
  return { id, schema_version: 1, record_type: "event", payload_type: "runtime.session", payload_schema_version: 1,
    recorded_at: now.valueOf() * 1000, payload: { event: { kind, model: "test-model", usage } } };
}
function pi(id: string, timestamp: string) {
  return { type: "message", id, timestamp, message: { role: "assistant", provider: "anthropic", model: "unknown",
    usage: { input: 1, output: 1, totalTokens: 2 } } };
}
function vi(value: number): Buffer {
  let n = BigInt(value); const a: number[] = [];
  do { const b = Number(n & 127n); n >>= 7n; a.push(b | (n ? 128 : 0)); } while (n);
  return Buffer.from(a);
}
function pb(field: number, value: number | string | Buffer): Buffer {
  if (typeof value === "number") return Buffer.concat([vi(field * 8), vi(value)]);
  const bytes = Buffer.from(value); return Buffer.concat([vi(field * 8 + 2), vi(bytes.length), bytes]);
}
function turn(response?: string) {
  return pb(1, Buffer.concat([pb(4, Buffer.concat([pb(1, 11), pb(2, 100), pb(5, 50), pb(9, 30), pb(10, 7), ...(response ? [pb(11, response)] : [])])),
    pb(9, pb(4, pb(1, now.valueOf() / 1000))), pb(19, "unknown")]));
}

it.each([1, 2])("rotates Antigravity archives with a file budget of %s and keeps recent usage", async maxFiles => {
  const d = await home(), root = antigravityRoots({ homeDirectory: d, environment: {} })[0].path;
  await mkdir(root, { recursive: true });
  const names = ["a-archive", "b-archive", "z-current"];
  for (const name of names) {
    const file = path.join(root, `${name}.db`), db = new DatabaseSync(file);
    db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
    db.prepare("INSERT INTO gen_metadata VALUES (0, ?)").run(turn()); db.close();
    await utimes(file, now, name === "z-current" ? new Date(now.valueOf() + 1000) : now);
  }
  const scanner = new AntigravityUsageScanner({ homeDirectory: d, environment: {}, workerPath, maxFiles });
  const collected = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const usage = await scanner.scan(context());
    const keys = usage.collection?.events.map(event => event.eventKey) ?? [];
    if (maxFiles > 1) expect(keys).toContain("antigravity|z-current|row:0");
    keys.forEach(key => collected.add(key));
    expect(usage.filesScanned).toBeLessThanOrEqual(maxFiles);
    expect(usage.status).toBe("partial");
  }
  expect([...collected].sort()).toEqual(names.map(name => `antigravity|${name}|row:0`));
});

it("a recent Antigravity file exhausting the byte budget does not starve archives", async () => {
  const d = await home(), root = antigravityRoots({ homeDirectory: d, environment: {} })[0].path;
  await mkdir(root, { recursive: true });
  const names = ["a-archive", "b-archive", "z-current"];
  for (const name of names) {
    const file = path.join(root, `${name}.db`), db = new DatabaseSync(file);
    db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
    db.prepare("INSERT INTO gen_metadata VALUES (0, ?)").run(name === "z-current" ? Buffer.alloc(10_000) : turn()); db.close();
    await utimes(file, now, name === "z-current" ? new Date(now.valueOf() + 1000) : now);
  }
  const scanner = new AntigravityUsageScanner({ homeDirectory: d, environment: {}, workerPath, maxFiles: 2, maxBytes: 1024 });
  const collected = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const usage = await scanner.scan(context());
    for (const event of usage.collection?.events ?? []) collected.add(event.eventKey);
  }
  expect([...collected].sort()).toEqual(names.slice(0, 2).map(name => `antigravity|${name}|row:0`));
});

it("copied Muse events in different session folders should count once", async () => {
  const d = await home();
  await jsonl(path.join(d, ".local/share/muse/sessions/2026/09/27/a/session.jsonl"), [muse("same-event")]);
  await jsonl(path.join(d, ".local/share/muse/sessions/2026/09/27/b/session.jsonl"), [muse("same-event")]);
  const a = await new JsonSessionUsageScanner("muse", { homeDirectory: d, environment: {} }).scan(context());
  expect(a.totals.requests).toBe(1);
});

it("repeated scans should reach current Pi usage after a large archive", async () => {
  const d = await home(), root = path.join(d, ".pi/agent/sessions");
  await jsonl(path.join(root, "a-archive.jsonl"), [{ type: "session", id: "old" }, ...Array.from({ length: 100_000 }, (_, i) => pi(String(i), "2025-01-01T00:00:00Z"))]);
  await jsonl(path.join(root, "z-current.jsonl"), [{ type: "session", id: "new" }, pi("current", now.toISOString())]);
  const scanner = new JsonSessionUsageScanner("pi", { homeDirectory: d, environment: {} });
  await scanner.scan(context());
  const second = await scanner.scan(context());
  expect(second.today.requests).toBe(1);
}, 30_000);

it("enriching one Antigravity row with its response ID should preserve one durable event", async () => {
  const d = await home(), root = antigravityRoots({ homeDirectory: d, environment: {} })[0].path;
  await mkdir(root, { recursive: true });
  const source = new DatabaseSync(path.join(root, "session.db"));
  source.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
  source.prepare("INSERT INTO gen_metadata VALUES (0, ?)").run(turn());
  const scanner = new AntigravityUsageScanner({ workerPath, homeDirectory: d, environment: {} });
  const first = await scanner.scan(context());
  source.prepare("UPDATE gen_metadata SET data = ? WHERE idx = 0").run(turn("response-1"));
  source.prepare("INSERT INTO gen_metadata VALUES (1, ?)").run(turn("response-1"));
  source.close();
  const second = await scanner.scan({ ...context(), now: new Date(now.valueOf() + 1000) });
  const db = openWritableSqlite(":memory:"), store = new UsageStore(db);
  try {
    store.statistics.collect("antigravity", "local", "replica", first);
    store.statistics.collect("antigravity", "local", "replica", second);
    const rows = db.all("SELECT event_id, payload FROM usage_event_latest");
    expect(first.collection?.events[0].eventKey).toBe(second.collection?.events[0].eventKey);
    expect(rows).toHaveLength(1);
  } finally { await db.close(); }
});

it("Muse schema drift carrying cached_input_tokens should stay incomplete", async () => {
  const d = await home();
  const row = muse("new", "new_inference_event");
  (row.payload.event as { usage: unknown }).usage = { cached_input_tokens: 50 };
  await jsonl(path.join(d, ".local/share/muse/sessions/2026/09/27/a/session.jsonl"), [row]);
  const a = await new JsonSessionUsageScanner("muse", { homeDirectory: d, environment: {} }).scan(context());
  expect(a.status).toBe("unavailable");
});

it("Antigravity scanning should let cancellation and other engine tasks run", async () => {
  const d = await home(), root = antigravityRoots({ homeDirectory: d, environment: {} })[0].path;
  await mkdir(root, { recursive: true });
  const source = new DatabaseSync(path.join(root, "session.db"));
  source.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB); BEGIN");
  // Well-formed unknown scalar fields alongside the supported usage envelope.
  const padding = Buffer.alloc(2048);
  for (let i = 0; i < padding.length; i += 2) { padding[i] = 0x10; padding[i + 1] = 1; }
  const data = Buffer.concat([padding, turn()]);
  const insert = source.prepare("INSERT INTO gen_metadata VALUES (?,?)");
  for (let i = 0; i < 5000; i++) insert.run(i, data);
  source.exec("COMMIT"); source.close();
  const scanner = new AntigravityUsageScanner({ workerPath, homeDirectory: d, environment: {} });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  let completed = false;
  try { await scanner.scan({ ...context(), signal: controller.signal }); completed = true; } catch { /* expected cancellation */ }
  clearTimeout(timer);
  expect(completed).toBe(false);
}, 30_000);

it("one broken link should not hide valid sibling session logs", async () => {
  const d = await home(), root = path.join(d, ".pi/agent/sessions");
  await mkdir(root, { recursive: true });
  await symlink(path.join(d, "missing-target"), path.join(root, "a-broken"), "junction");
  await jsonl(path.join(root, "z-valid.jsonl"), [{ type: "session", id: "live" }, pi("valid", now.toISOString())]);
  const scanner = new JsonSessionUsageScanner("pi", { homeDirectory: d, environment: {} });
  expect(await scanner.isAvailable()).toBe(true);
  const a = await scanner.scan(context());
  expect(a.status).toBe("partial");
  expect(a.totals.requests).toBe(1);
});

it("file batches advance while continuing to include the most recently written session", async () => {
  const d = await home(), root = path.join(d, ".pi/agent/sessions");
  for (let i = 0; i < 6; i++) {
    const file = path.join(root, `${i}.jsonl`);
    await jsonl(file, [{ type: "session", id: `session-${i}` }, pi(`turn-${i}`, now.toISOString())]);
    const modified = new Date(now.valueOf() + i * 1000); await utimes(file, modified, modified);
  }
  const scanner = new JsonSessionUsageScanner("pi", { homeDirectory: d, environment: {}, maxFiles: 2 });
  const collected = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const a = await scanner.scan(context());
    expect(a.status).toBe("partial"); expect(a.filesScanned).toBe(2);
    expect(a.collection?.events.some(event => event.eventKey === "pi|session-5|turn-5")).toBe(true);
    for (const event of a.collection!.events) collected.add(event.eventKey);
  }
  expect(collected.size).toBe(6);
});

it("reclaims reserved capacity when the complete history fits in one refresh", async () => {
  const d = await home(), root = path.join(d, ".pi/agent/sessions");
  await jsonl(path.join(root, "a-small.jsonl"), [{ type: "session", id: "small" }, pi("only", now.toISOString())]);
  await jsonl(path.join(root, "z-active.jsonl"), [{ type: "session", id: "active" }, ...Array.from({ length: 60_000 }, (_, i) => pi(String(i), now.toISOString()))]);
  const a = await new JsonSessionUsageScanner("pi", { homeDirectory: d, environment: {} }).scan(context());
  expect(a.status).toBe("available"); expect(a.totals.requests).toBe(60_001);
}, 30_000);

it("oversized session pages retain the tail and eventually persist every event exactly once", async () => {
  const d = await home(), file = path.join(d, "large.jsonl");
  await jsonl(file, [{ type: "session", id: "large" }, ...Array.from({ length: 12 }, (_, i) => pi(`turn-${i}`, now.toISOString()))]);
  const cache = new SessionFileCache(), db = openWritableSqlite(":memory:"), store = new UsageStore(db);
  try {
    for (let i = 0; i < 6; i++) {
      const parsed = await cache.read(file, context(), { bytes: 1_000_000 }, piSessionParser(file), "bundled", 4);
      expect(parsed.partial).toBe(true); expect(parsed.records.length).toBeLessThanOrEqual(4);
      expect(parsed.records.some(record => record.eventKey === "pi|large|turn-11")).toBe(true);
      store.statistics.collect("pi", "local", "replica", sessionAnalytics(parsed, 1, context()));
    }
    expect(db.all("SELECT event_id FROM usage_event_latest")).toHaveLength(12);
    // A rewrite is reparsed from its header, even after a cursor has advanced.
    await jsonl(file, [{ type: "session", id: "replacement" }, pi("fresh", now.toISOString())]);
    const replacement = await cache.read(file, context(), { bytes: 1_000_000 }, piSessionParser(file), "bundled", 4);
    expect(replacement.partial).toBe(false); expect(replacement.records[0].eventKey).toBe("pi|replacement|fresh");
  } finally { await db.close(); }
});

it("an unavailable Antigravity worker keeps history unavailable instead of reporting zero", async () => {
  const d = await home(), root = antigravityRoots({ homeDirectory: d, environment: {} })[0].path;
  await mkdir(root, { recursive: true });
  const source = new DatabaseSync(path.join(root, "session.db"));
  source.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)"); source.close();
  const a = await new AntigravityUsageScanner({ homeDirectory: d, environment: {}, workerPath: path.join(d, "missing-worker.js") }).scan(context());
  expect(a.status).toBe("unavailable"); expect(a.error?.code).toBe("analytics_unavailable");
});

it("OpenAI Codex backend uses disjoint counts and model-change pricing", async () => {
  const d = await home();
  const row = { type: "message", id: "turn", timestamp: now.toISOString(), message: { role: "assistant",
    usage: { input: 100, output: 20, cacheRead: 50, totalTokens: 170 } } };
  await jsonl(path.join(d, ".pi/agent/sessions/a.jsonl"), [{ type: "session", id: "live" },
    { type: "model_change", provider: "openai-codex", modelId: "gpt-5.4" }, row]);
  const catalog = pricingCatalogFromRates({ openai: { "gpt-5.4": { input: 1e-6, output: 2e-6, cacheRead: 0.1e-6 } } });
  const a = await new JsonSessionUsageScanner("pi", { homeDirectory: d, environment: {}, pricingCatalogLoader: async () => catalog }).scan(context());
  expect(a.status).toBe("available");
  expect(a.totals).toMatchObject({ inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, totalTokens: 170, requests: 1 });
  expect(a.totals.estimatedCostUSD).toBeCloseTo(0.000145, 10);
});

it("an unfinished Pi tail is recovered on the next scan without duplicate facts", async () => {
  const d = await home(), file = path.join(d, ".pi/agent/sessions/a.jsonl");
  const header = { type: "session", id: "live" }, first = pi("first", now.toISOString()), second = pi("second", now.toISOString());
  await jsonl(file, [header, first]);
  const scanner = new JsonSessionUsageScanner("pi", { homeDirectory: d, environment: {} });
  const complete = await scanner.scan(context());
  await writeFile(file, [header, first].map(r => JSON.stringify(r)).join("\n") + '\n{"type":');
  const partial = await scanner.scan(context());
  await jsonl(file, [header, first, second]);
  const recovered = await scanner.scan(context());
  expect(complete.status).toBe("available"); expect(partial.status).toBe("partial"); expect(recovered.status).toBe("available");
  expect(recovered.totals.requests).toBe(2);
  const db = openWritableSqlite(":memory:"), store = new UsageStore(db);
  try {
    for (const a of [complete, partial, recovered]) store.statistics.collect("pi", "local", "replica", a);
    expect(db.all("SELECT event_id FROM usage_event_latest")).toHaveLength(2);
  } finally { await db.close(); }
});
