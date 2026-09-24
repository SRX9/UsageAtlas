import { mkdir, mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalUsageScanner, buildAnalytics, type UsageRecord } from "./local-usage";
import { fetchCursorUsageHistory, parseCursorUsageEventsPage } from "./cursor-usage";
import { DatabaseSync } from "node:sqlite";
import { OpenCodeUsageScanner, openCodeLocations } from "./opencode-usage";
import { parseModelsDevCatalog } from "./models-dev";
import { parseClaudeUsage } from "../providers/claude";
import { estimateClaudeCost, estimateCodexCost } from "./pricing";

const now = new Date("2026-09-23T12:00:00Z");
const homes: string[] = [];
const context = () => ({ now, signal: new AbortController().signal, timeZone: "UTC" });
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function setup(provider: "codex" | "claude", options: { maxFiles?: number; maxLineBytes?: number } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "usageatlas-parsing-")); homes.push(home);
  const folder = path.join(home, provider === "codex" ? ".codex/sessions" : ".claude/projects/project");
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, "session.jsonl");
  const scanner = new LocalUsageScanner({ homeDirectory: home, environment: {}, ...options });
  return { file, folder, scan: () => scanner.scan(provider, context()) };
}
async function write(file: string, rows: unknown[]) { await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n"); }
function codex(input: number, output: number, extra: object = {}, time = now.toISOString()) {
  return { type: "event_msg", timestamp: time, payload: { type: "token_count", info: { model: "gpt-5.6-sol", last_token_usage: { input_tokens: input, output_tokens: output, ...extra } } } };
}
function claude(usage: object = { input_tokens: 10, output_tokens: 20 }, extra: object = {}) {
  return { type: "assistant", timestamp: now.toISOString(), sessionId: "session", message: { id: "message", model: "claude-sonnet-4-6", usage }, ...extra };
}
function cursor(usage: object = { inputTokens: 10, outputTokens: 20 }) {
  return { timestamp: now.toISOString(), model: "test", tokenUsage: usage };
}
async function cursorScan(rows: unknown[], extra: object = {}) {
  return fetchCursorUsageHistory(context(), {}, { timeZone: "UTC", fetch: async () => Response.json({ usageEventsDisplay: rows, totalUsageEventsCount: rows.length }), ...extra });
}

describe("local reader boundaries", () => {
  it("does not report truncation at exactly the file limit, including an empty archive root", async () => {
    const s = await setup("codex", { maxFiles: 1 }); await write(s.file, [codex(10, 20)]);
    await mkdir(path.join(s.folder, "empty"));
    expect((await s.scan()).status).toBe("available");
  });
  it("reports a malformed newline-terminated final entry and ignores only an unfinished tail", async () => {
    const s = await setup("codex"); await write(s.file, [codex(10, 20)]);
    await appendFile(s.file, '{"type":"event_msg","payload":');
    expect((await s.scan()).status).toBe("available");
    await appendFile(s.file, "\n");
    expect((await s.scan()).error?.message).toContain("1 log entry could not be parsed");
  });
  it("reads complete final usage without a newline, CRLF, and multibyte text", async () => {
    const s = await setup("codex");
    await writeFile(s.file, JSON.stringify({ type: "session_meta", payload: { id: "s", cwd: "C:/日本" } }) + "\r\n" + JSON.stringify(codex(10, 20)));
    const result = await s.scan(); expect(result.totals.totalTokens).toBe(30); expect(result.projects[0]?.label).toBe("日本");
  });
  it("uses structural types when nested metadata comes before the outer record type", async () => {
    const s = await setup("codex", { maxLineBytes: 65_536 });
    await write(s.file, [{ metadata: { type: "response_item" }, ...codex(10, 20), filler: "x".repeat(100_000) }]);
    expect((await s.scan()).error?.message).toContain("exceeded the scan size limit");
    await write(s.file, [{ metadata: { type: "token_count" }, payload: { data: "x".repeat(100_000), type: "item_completed" }, type: "event_msg" }]);
    // The outer type is beyond the retained prefix, so the reader honestly reports unknown coverage.
    expect((await s.scan()).status).toBe("partial");
    await write(s.file, [{ metadata: { type: "assistant" }, type: "response_item", content: "x".repeat(100_000) }]);
    expect((await s.scan()).status).toBe("no_data");
  });
  it("reports oversized complete final usage without a newline", async () => {
    const s = await setup("claude", { maxLineBytes: 65_536 });
    await writeFile(s.file, JSON.stringify({ ...claude(), content: "x".repeat(100_000) }));
    expect((await s.scan()).status).toBe("partial");
  });
  it("rescans after append and truncation without retaining old usage", async () => {
    const s = await setup("codex"); await write(s.file, [codex(10, 20)]);
    expect((await s.scan()).totals.totalTokens).toBe(30);
    await appendFile(s.file, JSON.stringify(codex(100, 20, {}, "2026-09-23T12:01:00Z")) + "\n");
    expect((await s.scan()).totals.totalTokens).toBe(150);
    await write(s.file, [codex(1, 2)]); expect((await s.scan()).totals.totalTokens).toBe(3);
  });
});

describe("Codex accounting", () => {
  it("uses the larger cached-token alias without adding the aliases together", async () => {
    const s = await setup("codex"); await write(s.file, [codex(100, 10, { cached_input_tokens: 0, cache_read_input_tokens: 80 })]);
    expect((await s.scan()).totals).toMatchObject({ inputTokens: 20, cachedInputTokens: 80, totalTokens: 110 });
  });
  it.each([true, -1, 1.5, "10", Number.MAX_SAFE_INTEGER])("does not price invalid cached counters %s as zero", async bad => {
    const s = await setup("codex"); await write(s.file, [codex(100, 10, { cached_input_tokens: bad })]);
    const result = await s.scan(); expect(result.status).toBe("partial"); expect(result.totals.totalTokens).toBe(0);
  });
  it("suppresses replayed cumulative snapshots without lowering the baseline", async () => {
    const s = await setup("codex");
    const rows = [100, 200, 100, 250].map((input, index) => ({ type: "event_msg", timestamp: `2026-09-23T10:00:0${index}Z`, payload: { type: "token_count", info: { last_token_usage: { input_tokens: index === 3 ? 50 : 100, output_tokens: 10 }, total_token_usage: { input_tokens: input, output_tokens: index === 3 ? 30 : input / 10 } } } }));
    await write(s.file, rows); expect((await s.scan()).totals.totalTokens).toBe(280);
  });
  it("counts an explicit counter reset whose total equals the new request", async () => {
    const s = await setup("codex");
    await write(s.file, [100, 5].map((input, index) => ({ type: "event_msg", timestamp: `2026-09-23T10:00:0${index}Z`, payload: { type: "token_count", info: { last_token_usage: { input_tokens: input, output_tokens: input }, total_token_usage: { input_tokens: input, output_tokens: input } } } })));
    expect((await s.scan()).totals.totalTokens).toBe(210);
  });
  it("resets explicit null service tiers to standard and reads turn identity from context", async () => {
    const s = await setup("codex");
    await write(s.file, [{ type: "turn_context", payload: { turn_id: "one", service_tier: "priority" } }, codex(10, 20), { type: "turn_context", payload: { turn_id: "two", service_tier: null } }, codex(10, 20)]);
    const a = await s.scan(); expect(a.totals.requests).toBe(2); expect(a.serviceTiers.map(tier => tier.id).sort()).toEqual(["priority", "standard"]);
  });
});

describe("Claude response identity and validation", () => {
  it("keeps different requests that reuse the same message id", async () => {
    const s = await setup("claude"); await write(s.file, [claude(undefined, { requestId: "one" }), claude(undefined, { requestId: "two" })]);
    expect((await s.scan()).totals.totalTokens).toBe(60);
  });
  it("keeps independent sessions when request ids are omitted", async () => {
    const s = await setup("claude"); await write(s.file, [claude(undefined, { sessionId: "one" }), claude(undefined, { sessionId: "two" })]);
    expect((await s.scan()).totals.totalTokens).toBe(60);
  });
  it("keeps complete usage when a later copied observation is incomplete", async () => {
    const s = await setup("claude"); await write(s.file, [claude(), claude({ input_tokens: 10 }, { timestamp: "2026-09-23T12:01:00Z" })]);
    const result = await s.scan(); expect(result.status).toBe("available"); expect(result.totals.totalTokens).toBe(30);
  });
  it("preserves equal anonymous calls as distinct requests", async () => {
    const s = await setup("claude"); const row = claude(); delete (row.message as { id?: string }).id;
    await write(s.file, [row, row]); expect((await s.scan()).totals.requests).toBe(2);
  });
  it("uses the aggregate cache count when the TTL breakdown is only partial", async () => {
    const s = await setup("claude"); await write(s.file, [claude({ input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 40 } })]);
    const a = await s.scan(); expect(a.totals.cacheCreationInputTokens).toBe(100); expect(a.totals.totalTokens).toBe(130);
  });
  it.each([true, -5, "50", null, 0.2])("keeps invalid optional counters %s unknown", async value => {
    const s = await setup("claude"); await write(s.file, [claude({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: value })]);
    const a = await s.scan(); expect(a.status).toBe("partial"); expect(a.collection?.events[0]?.measurement).toBe("unknown"); expect(a.totals.totalTokens).toBe(0);
  });
  it("does not warn about unknown measurements outside the requested period", async () => {
    const s = await setup("claude"); await write(s.file, [claude(), claude({ input_tokens: 10 }, { timestamp: "2020-01-01T12:00:00Z", requestId: "old" })]);
    expect((await s.scan()).status).toBe("available");
  });
});

describe("Cursor response boundaries", () => {
  it.each([{}, { totalUsageEventsCount: 0 }, { totalUsageEventsCount: "0" }])("accepts confirmed empty pages %s", async response => {
    const a = await fetchCursorUsageHistory(context(), {}, { fetch: async () => Response.json(response) });
    expect(a.status).toBe("no_data");
  });
  it("rejects error envelopes and invalid page counts", () => {
    for (const response of [{ error: "denied" }, { totalUsageEventsCount: false }, { totalUsageEventsCount: -1, usageEventsDisplay: [] }]) {
      expect(() => parseCursorUsageEventsPage(response, 1)).toThrow();
    }
  });
  it("accepts an exact event limit after proving the next page is empty", async () => {
    let requests = 0;
    const a = await fetchCursorUsageHistory(context(), {}, { maxEvents: 2, pageSize: 2, fetch: async () => Response.json({ totalUsageEventsCount: 2, ...(requests++ === 0 ? { usageEventsDisplay: [cursor(), cursor()] } : {}) }) });
    expect(a.totals.requests).toBe(2); expect(requests).toBe(2);
  });
  it.each([true, [], {}, " ", -1, 0.1])("does not coerce malformed counters %s into known usage", async value => {
    const a = await cursorScan([cursor({ inputTokens: 10, outputTokens: 20, cacheReadTokens: value })]);
    expect(a.status).toBe("partial"); expect(a.totals.totalTokens).toBe(0);
  });
  it("accepts numeric strings and preserves missing cost as unpriced", async () => {
    const a = await cursorScan([cursor({ inputTokens: "10", outputTokens: "20", cacheReadTokens: "5" })]);
    expect(a.status).toBe("available"); expect(a.totals).toMatchObject({ totalTokens: 35, unpricedTokens: 35, estimatedCostUSD: null });
  });
  it("does not turn boolean costs into dollars", async () => {
    expect((await cursorScan([cursor({ inputTokens: 10, outputTokens: 20, totalCents: true })])).totals.estimatedCostUSD).toBeNull();
  });
});

describe("aggregation and pricing invariants", () => {
  it("preserves totals across models, days, and repeated DST hours", () => {
    const timestamps = ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"];
    const rows: UsageRecord[] = timestamps.map((timestamp, i) => ({ timestamp, day: timestamp.slice(0, 10), model: `model-${i}`, sessionID: `s-${i}`, projectPath: null, projectLabel: "test", serviceTier: "standard", inputTokens: 10, cachedInputTokens: 20, cacheCreationInputTokens: 30, outputTokens: 40, totalTokens: 100, estimatedCostUSD: 0.001, eventKey: `${i}` }));
    const a = buildAnalytics(rows, new Date("2026-11-01T12:00:00Z"), 1, 1, false, "local_sessions", undefined, undefined, "America/New_York");
    expect(a.hourly).toHaveLength(2); expect(a.hourly?.map(row => row.hour)).toEqual([1, 1]);
    for (const breakdown of [a.daily, a.hourly!, a.models, a.dailyModels, a.projects, a.sessions, a.serviceTiers]) {
      expect(breakdown.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(a.totals.totalTokens);
      expect(breakdown.reduce((sum, row) => sum + row.requests, 0)).toBe(a.totals.requests);
    }
  });
  it("applies long-context pricing at the documented boundary and includes every input category", () => {
    const base = { model: "gpt-5.4", inputTokens: 272_000, cachedInputTokens: 100_000, cacheCreationInputTokens: 0, outputTokens: 10 };
    expect(estimateCodexCost(base)).toBeCloseTo(172_000 * 2.5e-6 + 100_000 * 2.5e-7 + 10 * 1.5e-5, 9);
    expect(estimateCodexCost({ ...base, inputTokens: 272_001 })).toBeCloseTo(172_001 * 5e-6 + 100_000 * 5e-7 + 10 * 2.25e-5, 9);
    expect(estimateClaudeCost({ model: "claude-sonnet-4-5", inputTokens: 1, cachedInputTokens: 200_000, cacheCreationInputTokens: 0, outputTokens: 10 })).toBeCloseTo(6e-6 + 200_000 * 6e-7 + 10 * 2.25e-5, 9);
  });
});


describe("OpenCode validation", () => {
  async function scanRows(messages: object[], options: { maxRecords?: number } = {}) {
    const home = await mkdtemp(path.join(tmpdir(), "usageatlas-opencode-audit-")); homes.push(home);
    const locations = openCodeLocations({ homeDirectory: home, environment: {} });
    await mkdir(locations.root, { recursive: true });
    const db = new DatabaseSync(locations.database);
    try {
      db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)");
      const insert = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
      messages.forEach((message, i) => insert.run(`m-${i}`, "session", now.valueOf(), JSON.stringify({ role: "assistant", modelID: "model", providerID: "openai", ...message })));
    } finally { db.close(); }
    return (await new OpenCodeUsageScanner({ homeDirectory: home, environment: {}, ...options }).scan(context())).analytics;
  }
  it("does not warn when a table has exactly the configured record limit", async () => {
    expect((await scanRows([{ tokens: { input: 10, output: 20 } }], { maxRecords: 1 })).status).toBe("available");
    expect((await scanRows([{ tokens: { input: 10, output: 20 } }, { tokens: { input: 1, output: 2 } }], { maxRecords: 1 })).status).toBe("partial");
  });
  it.each([true, -1, 1.5, [], {}])("does not mark malformed required counters %s as measured", async input => {
    const a = await scanRows([{ tokens: { input, output: 20 } }]);
    expect(a.status).toBe("partial"); expect(a.collection?.events[0]?.measurement).toBe("unknown"); expect(a.totals.requests).toBe(0);
  });
  it("keeps reasoning and cache categories separate and preserves unknown cost", async () => {
    const a = await scanRows([{ tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 40, write: 50 } } }]);
    expect(a.totals).toMatchObject({ inputTokens: 10, outputTokens: 25, cachedInputTokens: 40, cacheCreationInputTokens: 50, totalTokens: 125, unpricedTokens: 125, estimatedCostUSD: null });
  });
  it("retains a valid zero-token response without a parse warning", async () => {
    const a = await scanRows([{ tokens: { input: 0, output: 0 } }]);
    expect(a.status).toBe("available"); expect(a.totals.requests).toBe(1); expect(a.totals.totalTokens).toBe(0);
  });
});

describe("quota and price source validation", () => {
  it.each([{}, { utilization: null }, { utilization: false }, { utilization: -1 }])("does not display an unknown Claude quota %s as unused", window => {
    expect(() => parseClaudeUsage({ five_hour: window }, null, now)).toThrow("invalid usage response");
  });
  it("selects the highest matching context price independently of catalog order", () => {
    const catalog = parseModelsDevCatalog({ openai: { models: { future: { cost: { input: 1, output: 2, tiers: [
      { tier: { type: "context", size: 200 }, input: 3, output: 6 },
      { tier: { type: "context", size: 100 }, input: 2, output: 4 }
    ] } } } } });
    const input = { model: "future", inputTokens: 100, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 10 };
    expect(estimateCodexCost(input, catalog)).toBeCloseTo(120e-6, 9);
    expect(estimateCodexCost({ ...input, inputTokens: 101 }, catalog)).toBeCloseTo(242e-6, 9);
    expect(estimateCodexCost({ ...input, inputTokens: 201 }, catalog)).toBeCloseTo(663e-6, 9);
  });
});
