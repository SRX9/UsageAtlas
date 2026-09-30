import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildAntigravityTestWorker } from "./antigravity-test-worker";
import { validateUsageFact } from "@usageatlas/contracts/statistics";
import { validateUsageRecord } from "@usageatlas/contracts/usage";
import { AntigravityUsageScanner, antigravityRoots } from "./antigravity-usage";
import { JsonSessionUsageScanner, sessionRoots } from "./pi-muse-usage";
import { pricingCatalogFromRates } from "./models-dev";
import { createLocalToolAdapter } from "../providers/local-tools";
import { openWritableSqlite } from "../platform/sqlite";
import { UsageStore } from "../history/usage-store";
import { extractDayPayload } from "../history/payload";
import { toUsageDay } from "../history/usage-payload";

const directories: string[] = [];
let workerPath: string;
beforeAll(async () => { workerPath = await buildAntigravityTestWorker(); });
const now = new Date("2026-09-27T12:00:00Z");
const context = () => ({ now, historyDays: 90, timeZone: "UTC", signal: new AbortController().signal });
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { force: true, recursive: true }); });
async function home() { const dir = await mkdtemp(path.join(tmpdir(), "usageatlas-local-tools-")); directories.push(dir); return dir; }
async function jsonl(file: string, rows: unknown[], tail = "") {
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n" + tail);
}
const piHeader = { type: "session", version: 3, id: "session-pi-1", cwd: "C:/private/atlas", timestamp: now.toISOString() };
function piMessage(id = "turn-1", usage = { input: 100, cacheRead: 50, cacheWrite: 10, output: 20, totalTokens: 180 }) {
  return { type: "message", id, timestamp: "2026-09-26T23:30:00Z", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-6", usage,
    content: [{ type: "text", text: "PRIVATE PROMPT CONTENT" }] } };
}
function museEvent(id = "muse-turn-1", kind = "model_completed", usage: Record<string, unknown> = { input_tokens: 100, output_tokens: 25, cached_tokens: 70, cache_read_tokens: 70, reasoning_tokens: 10 }) {
  return { schema_version: 1, record_type: "event", payload_type: "runtime.session", payload_schema_version: 1, id,
    recorded_at: Date.parse("2026-09-26T23:30:00Z") * 1000,
    payload: { event: { kind, model: "muse-spark-1.3-contributor-free", usage } } };
}
// Independent literal fixture from CodexBar's AntigravityLocalReaderTests, pinned f795611.
// Input 11+100, cache 50, text 30, thinking 7; timestamp 2026-08-27.
const literalTurn = Buffer.from("0a1b220a080b10642832481e50074a0d220b08c0cdc0d4061080e59a77", "hex");
function varint(value: number): Buffer {
  let n = BigInt(value); const bytes: number[] = [];
  do { const low = Number(n & 127n); n >>= 7n; bytes.push(low | (n ? 128 : 0)); } while (n);
  return Buffer.from(bytes);
}
function pb(number: number, value: number | Buffer | string): Buffer {
  if (typeof value === "number") return Buffer.concat([varint(number * 8), varint(value)]);
  const data = Buffer.from(value); return Buffer.concat([varint(number * 8 + 2), varint(data.length), data]);
}
function turn(options: { time?: boolean; response?: string; step?: string; bot?: string; model?: string; input?: number } = {}): Buffer {
  const usage = Buffer.concat([pb(1, options.input ?? 11), pb(2, 100), pb(5, 50), pb(9, 30), pb(10, 7),
    ...(options.response ? [pb(11, options.response)] : []), ...(options.bot ? [pb(7, options.bot)] : [])]);
  const chat = Buffer.concat([pb(4, usage), pb(19, options.model ?? "gemini-test"),
    ...(options.time !== false ? [pb(9, pb(4, pb(1, now.valueOf() / 1000)))] : [])]);
  return Buffer.concat([pb(1, chat), ...(options.step ? [pb(4, options.step)] : [])]);
}
async function database(dir: string, blobs: Buffer[], steps: Buffer[] = [], filename = "session.db", rootIndex = 0) {
  const root = antigravityRoots({ homeDirectory: dir, environment: {} })[rootIndex].path;
  await mkdir(root, { recursive: true }); const file = path.join(root, filename);
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);");
  blobs.forEach((blob, i) => db.prepare("INSERT INTO gen_metadata VALUES (?,?)").run(i, blob));
  steps.forEach((blob, i) => db.prepare("INSERT INTO steps VALUES (?,?)").run(i, blob)); db.close(); return file;
}

describe("Pi / OMP history", () => {
  it("maps disjoint token classes, projects, model changes and duplicate sessions without counting content", async () => {
    const dir = await home(), options = { homeDirectory: dir, environment: {} };
    const rows = [piHeader, piMessage()];
    await jsonl(path.join(dir, ".pi/agent/sessions/project/a.jsonl"), rows);
    await jsonl(path.join(dir, ".omp/agent/sessions/project/copy.jsonl"), rows);
    const scanner = new JsonSessionUsageScanner("pi", options);
    const a = await scanner.scan({ ...context(), timeZone: "Asia/Calcutta" });
    expect(a.status).toBe("available");
    expect(a.totals).toMatchObject({ inputTokens: 100, cachedInputTokens: 50, cacheCreationInputTokens: 10, outputTokens: 20, totalTokens: 180, requests: 1, unpricedTokens: 0 });
    expect(a.daily[0].date).toBe("2026-09-27");
    expect(a.projects[0].label).toBe("atlas"); expect(a.collection?.events[0].modelProvider).toBe("anthropic");
    expect(JSON.stringify(a)).not.toContain("PRIVATE PROMPT CONTENT");
    expect(await scanner.scan({ ...context(), timeZone: "Asia/Calcutta" })).toEqual(a);
  });
  it("keeps unknown models unpriced and marks unsupported backends and malformed tails incomplete", async () => {
    const dir = await home(), first = piMessage(); first.message.model = "private-new-model";
    const second = piMessage("turn-2"); second.message.provider = "google";
    await jsonl(path.join(dir, ".pi/agent/sessions/a.jsonl"), [piHeader, first, second], '{"type":');
    const a = await new JsonSessionUsageScanner("pi", { homeDirectory: dir, environment: {} }).scan(context());
    expect(a.status).toBe("partial"); expect(a.totals.requests).toBe(1); expect(a.totals.estimatedCostUSD).toBeNull(); expect(a.totals.unpricedTokens).toBe(180);
  });
  it("rejects negative, unsafe, missing and inconsistent usage instead of fabricating zero", async () => {
    const dir = await home(), file = path.join(dir, ".pi/agent/sessions/a.jsonl");
    await jsonl(file, [piHeader, piMessage("bad", { input: -1, cacheRead: 0, cacheWrite: 0, output: 1, totalTokens: 0 })]);
    const scanner = new JsonSessionUsageScanner("pi", { homeDirectory: dir, environment: {} });
    expect((await scanner.scan(context())).status).toBe("unavailable");
    await jsonl(file, [piHeader, piMessage("fixed")]); expect((await scanner.scan(context())).status).toBe("available");
    const row = piMessage(); row.message.usage.totalTokens = 999;
    await jsonl(file, [piHeader, row]); expect((await scanner.scan(context())).status).toBe("unavailable");
  });
  it("selects OMP profiles and explicit roots without importing sibling profiles", async () => {
    const dir = await home();
    await jsonl(path.join(dir, ".omp/profiles/work/sessions/a.jsonl"), [piHeader, piMessage()]);
    await jsonl(path.join(dir, ".omp/profiles/personal/sessions/b.jsonl"), [{ ...piHeader, id: "other" }, piMessage("turn-2")]);
    const a = await new JsonSessionUsageScanner("pi", { homeDirectory: dir, environment: { OMP_PROFILE: "work" } }).scan(context());
    expect(a.status).toBe("available"); expect(a.totals.requests).toBe(1);
    await expect(sessionRoots("pi", { OMP_PROFILE: "../private" }, dir)).rejects.toThrow();
    await expect(sessionRoots("pi", { PI_CODING_AGENT_SESSION_DIR: "relative" }, dir)).rejects.toThrow();
    const custom = path.join(dir, "custom"); await jsonl(path.join(custom, "a.jsonl"), [piHeader, piMessage()]);
    const roots = await sessionRoots("pi", { PI_CODING_AGENT_SESSION_DIR: custom }, dir); expect(roots).toHaveLength(1); expect(roots[0].path).toBe(custom);
  });
  it("withholds conflicting copies, but keeps separate IDs with equal counts", async () => {
    const dir = await home(), file = path.join(dir, ".pi/agent/sessions/a.jsonl");
    const second = piMessage(); second.message.usage.input = 110; second.message.usage.totalTokens = 190;
    await jsonl(file, [piHeader, piMessage(), piMessage("another"), second]);
    const a = await new JsonSessionUsageScanner("pi", { homeDirectory: dir, environment: {} }).scan(context());
    expect(a.status).toBe("partial"); expect(a.totals.requests).toBe(1); expect(a.collection?.events[0].eventKey).toContain("another");
  });
});

describe("Muse Code history", () => {
  it("counts inference and review events once with cache and reasoning as subsets, without fetching prices", async () => {
    const dir = await home(), file = path.join(dir, ".local/share/muse/sessions/2026/09/25/session-muse/session.jsonl");
    const review = museEvent("review", "automated_review_completed", { input_tokens: 20, output_tokens: 5, total_tokens: 25 });
    const price = vi.fn();
    await jsonl(file, [museEvent(), museEvent(), review, museEvent("cpu", "resource_usage_sampled"), museEvent("rollup", "workflow_child_lifecycle")]);
    const a = await new JsonSessionUsageScanner("muse", { homeDirectory: dir, environment: {}, pricingCatalogLoader: price }).scan(context());
    expect(a.status).toBe("available"); expect(a.totals).toMatchObject({ inputTokens: 50, cachedInputTokens: 70, outputTokens: 30, totalTokens: 150, requests: 2, estimatedCostUSD: null, unpricedTokens: 150 });
    expect(a.daily[0].date).toBe("2026-09-26"); expect(a.collection?.events[0].rawTokens?.reasoning).toBe(10); expect(price).not.toHaveBeenCalled();
  });
  it("keeps unsupported schemas and contradictory subset counters incomplete", async () => {
    const dir = await home();
    const bad = museEvent("bad"); bad.payload.event.usage.cache_read_tokens = 90;
    await jsonl(path.join(dir, "sessions/2026/09/27/one/session.jsonl"), [museEvent(), bad, { ...museEvent("v2"), schema_version: 2 }, museEvent("drift", "new_inference")]);
    const a = await new JsonSessionUsageScanner("muse", { homeDirectory: dir, environment: { MUSE_SESSIONS_DIR: path.join(dir, "sessions") } }).scan(context());
    expect(a.status).toBe("partial"); expect(a.totals.requests).toBe(1);
  });
});

describe("Antigravity history", () => {
  it("decodes independent bytes into 198 tokens and reads the source database without changing it", async () => {
    const dir = await home(), file = await database(dir, [literalTurn]); const before = await readFile(file);
    const a = await new AntigravityUsageScanner({ workerPath, homeDirectory: dir, environment: {} }).scan(context());
    expect(a.status).toBe("available"); expect(a.totals).toMatchObject({ inputTokens: 111, cachedInputTokens: 50, outputTokens: 37, totalTokens: 198, requests: 1, estimatedCostUSD: null });
    expect(a.daily[0].date).toBe("2026-08-27"); expect(await readFile(file)).toEqual(before);
  });
  it("deduplicates copied sessions and responses, preserves models and prices Gemini token categories", async () => {
    const dir = await home(), blobs = [turn({ response: "r1" }), turn({ response: "r1" }), turn({ response: "r2", model: "unknown" })];
    await database(dir, blobs); await database(dir, blobs, [], "session.db", 1);
    const catalog = pricingCatalogFromRates({ google: { "gemini-test": { input: 1e-6, output: 2e-6, cacheRead: 0.2e-6 } } });
    const a = await new AntigravityUsageScanner({ workerPath, homeDirectory: dir, environment: {}, pricingCatalogLoader: async () => catalog }).scan(context());
    expect(a.status).toBe("available"); expect(a.totals.requests).toBe(2); expect(a.totals.totalTokens).toBe(396);
    expect(a.totals.unpricedTokens).toBe(198); expect(a.totals.estimatedCostUSD).toBeCloseTo(0.000195);
  });
  it("uses exact step/bot timestamps and leaves unlinked or reused ambiguous UUIDs incomplete", async () => {
    const dir = await home();
    const step = Buffer.concat([pb(12, "step-1"), pb(9, pb(7, "bot-1")), pb(1, pb(1, now.valueOf() / 1000))]);
    await database(dir, [turn({ time: false, step: "step-1", bot: "bot-1" }), turn({ time: false })], [step]);
    const a = await new AntigravityUsageScanner({ workerPath, homeDirectory: dir, environment: {} }).scan(context());
    expect(a.status).toBe("partial"); expect(a.totals.requests).toBe(1); expect(a.daily[0].date).toBe("2026-09-27");
  });
  it("withholds copies whose row identity disagrees even when their response IDs differ", async () => {
    const dir = await home();
    await database(dir, [turn({ response: "original" }), turn({ response: "stable" })]);
    await database(dir, [turn({ response: "different", input: 12 }), turn({ response: "stable" })], [], "session.db", 1);
    const a = await new AntigravityUsageScanner({ workerPath, homeDirectory: dir, environment: {} }).scan(context());
    expect(a.status).toBe("partial"); expect(a.totals.requests).toBe(1); expect(a.collection?.events[0].eventKey).toBe("antigravity|session|row:1");
  });
  it("retains a known empty source but rejects overflowing combined totals", async () => {
    const dir = await home(); await database(dir, []);
    expect((await new AntigravityUsageScanner({ workerPath, homeDirectory: dir, environment: {} }).scan(context())).status).toBe("no_data");
    const huge = await home(); await database(huge, [turn({ response: "a", input: 5_000_000_000_000_000 }), turn({ response: "b", input: 5_000_000_000_000_000 })]);
    const a = await new AntigravityUsageScanner({ workerPath, homeDirectory: huge, environment: {} }).scan(context());
    expect(a.status).toBe("unavailable"); expect(a.error?.code).toBe("analytics_overflow");
  });
  it("rejects malformed protobuf and views while skipping unrelated summary databases", async () => {
    const dir = await home(); await database(dir, [literalTurn, Buffer.from([10, 128])]);
    const root = antigravityRoots({ homeDirectory: dir, environment: {} })[1].path; await mkdir(root, { recursive: true });
    const summary = new DatabaseSync(path.join(root, "conversation_summaries.db")); summary.exec("CREATE TABLE summaries (name TEXT)"); summary.close();
    const a = await new AntigravityUsageScanner({ workerPath, homeDirectory: dir, environment: {} }).scan(context());
    expect(a.status).toBe("partial"); expect(a.filesScanned).toBe(1); expect(a.totals.requests).toBe(1);
    const viewHome = await home(), viewRoot = antigravityRoots({ homeDirectory: viewHome, environment: {} })[0].path;
    await mkdir(viewRoot, { recursive: true }); const view = new DatabaseSync(path.join(viewRoot, "view.db"));
    view.exec("CREATE VIEW gen_metadata AS SELECT 1 AS idx, x'00' AS data"); view.close();
    expect((await new AntigravityUsageScanner({ workerPath, homeDirectory: viewHome, environment: {} }).scan(context())).status).toBe("unavailable");
  });
  it("does not report a missing, unreadable, undated, or budget-exhausted source as measured zero", async () => {
    const dir = await home();
    const scanner = new AntigravityUsageScanner({ workerPath, homeDirectory: dir, environment: {} });
    expect(await scanner.isAvailable()).toBe(false); expect((await scanner.scan(context())).status).toBe("unavailable");
    await database(dir, [turn({ time: false })]); expect((await scanner.scan(context())).status).toBe("unavailable");
    const limited = new AntigravityUsageScanner({ workerPath, homeDirectory: dir, environment: {}, maxBytes: 1 });
    expect((await limited.scan(context())).status).toBe("unavailable");
  });
});

describe("new providers through unified storage", () => {
  it.each(["antigravity", "pi", "muse"] as const)("persists and validates %s facts and daily totals idempotently without prompts or paths", async provider => {
    const dir = await home();
    if (provider === "antigravity") await database(dir, [turn({ response: "id-1" })]);
    if (provider === "pi") await jsonl(path.join(dir, ".pi/agent/sessions/a.jsonl"), [piHeader, piMessage()]);
    if (provider === "muse") await jsonl(path.join(dir, ".local/share/muse/sessions/2026/09/26/one/session.jsonl"), [museEvent()]);
    const options = { homeDirectory: dir, environment: {}, workerPath };
    const adapter = createLocalToolAdapter(provider, options);
    expect(await adapter.isAvailable!()).toBe(true);
    const snapshot = await adapter.refresh({ ...context(), historyDaysForAccount: () => 90, reportingTimeZoneForAccount: () => "UTC" });
    expect(snapshot.accountKey).toBe("local"); expect(snapshot.windows).toEqual([]); expect(snapshot.error).toBeNull();
    const analytics = snapshot.analytics!;
    const db = openWritableSqlite(":memory:"), store = new UsageStore(db); store.selectAccount("owner");
    try {
      store.statistics.collect(provider, "local", "replica", analytics); store.statistics.collect(provider, "local", "replica", analytics);
      const facts = store.statistics.pending(); expect(facts.filter(f => f.kind === "usage_event")).toHaveLength(1);
      for (const fact of facts) expect(validateUsageFact(fact)).toBe(fact);
      expect(JSON.stringify(facts)).not.toContain("C:/private/atlas"); expect(JSON.stringify(facts)).not.toContain("PRIVATE PROMPT CONTENT");
      const day = analytics.daily[0].date;
      const payload = extractDayPayload(analytics, day, { accountKey: "local", windows: [], identity: null, credits: null, source: "local_sessions", capturedAt: now.toISOString(), includeCoverageWideBreakdowns: true, timeZone: "UTC" });
      const record = toUsageDay({ id: "", providerId: provider, accountKey: "local", localDay: day, sealed: true, changeSeq: 1, updatedAt: now.toISOString(), payload }, "replica", "UTC");
      expect(validateUsageRecord(record)).toBe(record); expect(record.totals?.totalTokens).toBe(analytics.totals.totalTokens);
    } finally { await db.close(); }
  });
});
