import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { UsageRecord } from "./local-usage";
import {
  clineRowParser,
  geminiRowParser,
  JsonFileUsageScanner,
  qwenRowParser
} from "./json-file-usage";

const folders: string[] = [];
function folder(): string {
  const created = mkdtempSync(path.join(tmpdir(), "usageatlas-json-"));
  folders.push(created);
  return created;
}
afterAll(() => {
  for (const created of folders) rmSync(created, { recursive: true, force: true });
});

function parse(parser: (row: Record<string, unknown>, line: number) => UsageRecord | null, rows: unknown[]): UsageRecord[] {
  return rows.flatMap((row, index) => {
    const record = parser(row as Record<string, unknown>, index + 1);
    return record ? [record] : [];
  });
}

describe("Gemini CLI transcripts", () => {
  const parser = geminiRowParser(path.join("tmp", "my-project", "chats", "session-a.jsonl"), Date.parse("2026-10-01T10:00:00Z"));

  it("splits cached prompt tokens out of the reported total", () => {
    const records = parse(parser, [
      { sessionId: "session-a", startTime: "2026-10-01T09:00:00Z" },
      {
        type: "gemini",
        id: "msg-1",
        timestamp: "2026-10-01T09:04:00Z",
        model: "gemini-2.5-pro",
        tokens: { input: 1000, output: 200, cached: 400, thoughts: 50, tool: 3, total: 1250 }
      }
    ]);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.totalTokens).toBe(1250);
    expect(record.cachedInputTokens).toBe(400);
    expect(record.inputTokens).toBe(600);
    expect(record.outputTokens).toBe(250);
    expect(record.model).toBe("gemini-2.5-pro");
    expect(record.modelProvider).toBe("google");
    expect(record.eventKey).toBe("gemini|session-a|msg-1");
    // Only numbers are retained from the transcript.
    expect(JSON.stringify(record)).not.toContain("prompt");
  });

  it("skips non-model records without marking the file unreadable", () => {
    const records = parse(parser, [
      { type: "user", id: "u1", content: "Hello" },
      { type: "gemini", id: "g1", tokens: { input: 10, output: 5, cached: 0, total: 15 } }
    ]);
    expect(records).toHaveLength(1);
    expect(records[0].totalTokens).toBe(15);
  });
});

describe("Qwen Code transcripts", () => {
  const parser = qwenRowParser(path.join("projects", "repo", "chats", "abc.jsonl"), Date.parse("2026-10-02T10:00:00Z"));

  it("reads usageMetadata and keeps cached tokens separate", () => {
    const records = parse(parser, [
      {
        sessionId: "qwen-session",
        uuid: "q1",
        timestamp: "2026-10-02T10:05:00Z",
        type: "assistant",
        model: "qwen3-coder-plus",
        usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 300, cachedContentTokenCount: 100, totalTokenCount: 1200 }
      }
    ]);
    expect(records).toHaveLength(1);
    expect(records[0].totalTokens).toBe(1200);
    expect(records[0].cachedInputTokens).toBe(100);
    expect(records[0].inputTokens).toBe(800);
    expect(records[0].eventKey).toBe("qwen|qwen-session|q1");
  });

  it("rejects a total that does not add up instead of guessing", () => {
    expect(() => parse(parser, [{
      uuid: "q2",
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 99 }
    }])).toThrow();
  });
});

describe("Cline and Roo task transcripts", () => {
  const cline = clineRowParser("cline", path.join("tasks", "task-42", "ui_messages.json"), Date.parse("2026-10-03T10:00:00Z"));

  it("reads the usage packed into an api_req_started message", () => {
    const records = parse(cline, [
      { ts: Date.parse("2026-10-03T10:02:00Z"), type: "say", say: "text", text: "Working" },
      {
        ts: Date.parse("2026-10-03T10:03:00Z"),
        type: "say",
        say: "api_req_started",
        modelInfo: { modelId: "claude-sonnet-4-5" },
        text: JSON.stringify({ tokensIn: 1200, tokensOut: 340, cacheWrites: 60, cacheReads: 200, cost: 0.02 })
      }
    ]);
    expect(records).toHaveLength(1);
    expect(records[0].inputTokens).toBe(1200);
    expect(records[0].outputTokens).toBe(340);
    expect(records[0].cachedInputTokens).toBe(200);
    expect(records[0].cacheCreationInputTokens).toBe(60);
    expect(records[0].modelProvider).toBe("anthropic");
    expect(records[0].sessionID).toBe("task-42");
  });

  it("ignores a pending request with no usage yet", () => {
    expect(parse(cline, [{ ts: 1, say: "api_req_started", text: "{}" }])).toHaveLength(0);
  });
});

describe("JsonFileUsageScanner", () => {
  it("finds Cline tasks under a configured global storage", async () => {
    const root = folder();
    const task = path.join(root, "saoudrizwan.claude-dev", "tasks", "task-7");
    mkdirSync(task, { recursive: true });
    writeFileSync(path.join(task, "ui_messages.json"), JSON.stringify([
      { ts: Date.parse("2026-10-04T08:00:00Z"), say: "api_req_started", modelInfo: { modelId: "gpt-5" },
        text: JSON.stringify({ tokensIn: 500, tokensOut: 100 }) }
    ]));
    const scanner = new JsonFileUsageScanner("cline", {
      environment: { CLINE_GLOBAL_STORAGE: root } as NodeJS.ProcessEnv,
      homeDirectory: root
    });
    expect(await scanner.isAvailable()).toBe(true);
    const analytics = await scanner.scan({ signal: new AbortController().signal, now: new Date("2026-10-04T12:00:00Z"), historyDays: 30 });
    expect(analytics.status).toBe("available");
    expect(analytics.today.totalTokens).toBe(600);
    expect(analytics.daily).toHaveLength(1);
  });

  it("reads Gemini chats from tmp/<project>/chats", async () => {
    const root = folder();
    const chats = path.join(root, "tmp", "project-1", "chats");
    mkdirSync(chats, { recursive: true });
    writeFileSync(path.join(chats, "session-2026-10-05.jsonl"), [
      JSON.stringify({ sessionId: "g-session" }),
      JSON.stringify({ type: "gemini", id: "m1", timestamp: "2026-10-05T09:00:00Z", model: "gemini-2.5-flash", tokens: { input: 200, output: 50, cached: 0, total: 250 } })
    ].join("\n") + "\n");
    const scanner = new JsonFileUsageScanner("gemini", {
      environment: { GEMINI_DIR: root } as NodeJS.ProcessEnv,
      homeDirectory: root
    });
    const analytics = await scanner.scan({ signal: new AbortController().signal, now: new Date("2026-10-05T12:00:00Z") });
    expect(analytics.status).toBe("available");
    expect(analytics.today.totalTokens).toBe(250);
  });
});
