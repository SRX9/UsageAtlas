import claudeFixture from "@usageatlas/contracts/fixtures/providers/claude-oauth-usage.json";
import codexFixture from "@usageatlas/contracts/fixtures/providers/codex-oauth-usage.json";
import cursorFixture from "@usageatlas/contracts/fixtures/providers/cursor-usage-summary.json";
import cursorEventsFixture from "@usageatlas/contracts/fixtures/providers/cursor-usage-events.json";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeAdapter, parseClaudeUsage } from "./claude";
import { ProviderError } from "../provider";
import { createCodexAdapter, parseCodexRateLimits } from "./codex";
import { createCursorAdapter, parseCursorUsage } from "./cursor";
import { createProviderAdapters } from "./registry";

const now = new Date("2023-11-14T22:13:20.000Z");
const directories: string[] = [];

function testContext(signal = new AbortController().signal) {
  return {
    signal,
    now,
    historyDays: 90,
    historyDaysForAccount: () => 90
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("provider adapters", () => {
  it("advertises only providers with working TypeScript adapters", () => {
    expect(createProviderAdapters().map((adapter) => adapter.id)).toEqual([
      "codex",
      "claude",
      "cursor",
      "opencode"
    ]);
  });

  it("maps Codex session, weekly, plan, and credits", () => {
    const result = parseCodexRateLimits(codexFixture, now);
    expect(result.windows.map((window) => window.kind)).toEqual(["session", "weekly"]);
    expect(result.windows.map((window) => window.usedPercent)).toEqual([25, 40]);
    expect(result.windows.map((window) => window.remainingPercent)).toEqual([75, 60]);
    expect(result.identity?.plan).toBe("pro");
    expect(result.credits?.remaining).toBe(42.5);
  });

  it("maps Claude OAuth windows and remaining extra usage", () => {
    const result = parseClaudeUsage(claudeFixture, "max", now);
    expect(result.windows.map((window) => window.usedPercent)).toEqual([68, 54]);
    expect(result.windows.map((window) => window.remainingPercent)).toEqual([32, 46]);
    expect(result.identity?.plan).toBe("max");
    expect(result.credits).toEqual({ remaining: 76.5, unit: "USD" });
  });

  it("maps Cursor plan categories, billing reset, plan, and on-demand balance", () => {
    const result = parseCursorUsage(cursorFixture, now);
    expect(result.windows.map((window) => window.kind)).toEqual(["plan", "auto", "api"]);
    expect(result.windows.map((window) => window.usedPercent)).toEqual([25, 20, 5]);
    expect(result.windows.map((window) => window.remainingPercent)).toEqual([75, 80, 95]);
    expect(result.identity?.plan).toBe("Cursor Pro");
    expect(result.credits).toEqual({ remaining: 37.5, unit: "USD" });
  });

  it("reads Codex limits through the official app server", async () => {
    const home = await createHome();
    const appServer = vi.fn(async () => codexFixture);
    const result = await createCodexAdapter({ homeDirectory: home, environment: {}, appServer })
      .refresh(testContext());
    expect(result.windows).toHaveLength(2);
    expect(appServer).toHaveBeenCalledOnce();
  });

  it("uses the Claude environment token without reading a credential file", async () => {
    const home = await createHome();
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer claude-token");
      expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
      return Response.json(claudeFixture);
    });
    const result = await createClaudeAdapter({
      environment: { CLAUDE_CODE_OAUTH_TOKEN: "claude-token" },
      homeDirectory: home,
      fetch: request
    }).refresh(testContext());
    expect(result.windows).toHaveLength(2);
  });

  it("reuses the signed-in Cursor desktop session without exposing its token", async () => {
    const home = await createHome();
    const databasePath = path.join(home, "Cursor", "User", "globalStorage", "state.vscdb");
    await mkdir(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const token = cursorToken({ sub: "auth0|cursor-user", exp: 2_000_000_000 });
    database.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
      .run("cursorAuth/accessToken", token);
    database.close();
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("cookie")).toBe(`WorkosCursorSessionToken=cursor-user%3A%3A${token}`);
      if (String(url) === "https://cursor.com/api/usage-summary") return Response.json(cursorFixture);
      expect(String(url)).toBe("https://cursor.com/api/dashboard/get-filtered-usage-events");
      expect(init?.method).toBe("POST");
      expect(headers.get("origin")).toBe("https://cursor.com");
      expect(JSON.parse(String(init?.body))).toMatchObject({ page: 1, pageSize: 1_000 });
      return Response.json(cursorEventsFixture);
    });
    const adapter = createCursorAdapter({
      environment: { APPDATA: home },
      homeDirectory: home,
      platform: "win32",
      fetch: request
    });
    expect(await adapter.isAvailable?.()).toBe(true);
    const result = await adapter.refresh(testContext());
    expect(result.windows).toHaveLength(3);
    expect(result.source).toBe("cursor_app");
    expect(result.accountKey).toBe("cursor-user");
    expect(result.analytics).toMatchObject({
      status: "available",
      source: "remote_usage",
      recordsProcessed: 3,
      totals: {
        inputTokens: 300,
        cachedInputTokens: 70,
        cacheCreationInputTokens: 10,
        outputTokens: 130,
        totalTokens: 510,
        requests: 3,
        estimatedCostUSD: 0.06
      }
    });
    expect(result.analytics?.models.map((model) => model.id)).toEqual([
      "composer-2",
      "claude-4.6-sonnet-medium-thinking",
      "auto"
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps local analytics available when remote credentials are missing", async () => {
    const home = await createHome();
    const appServer = vi.fn(async () => {
      throw new ProviderError("credentials_missing", "Codex CLI is not installed.");
    });
    const result = await createCodexAdapter({ homeDirectory: home, environment: {}, appServer })
      .refresh(testContext());
    expect(result.error?.code).toBe("credentials_missing");
    expect(result.analytics?.status).toBe("no_data");
  });
});

async function createHome(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "usageatlas-provider-"));
  directories.push(directory);
  return directory;
}

function cursorToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}
