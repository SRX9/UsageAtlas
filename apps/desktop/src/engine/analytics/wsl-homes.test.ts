import claudeFixture from "@usageatlas/contracts/fixtures/providers/claude-oauth-usage.json";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LocalUsageScanner } from "./local-usage";
import { OpenCodeUsageScanner, openCodeLocations } from "./opencode-usage";
import { JsonSessionUsageScanner } from "./pi-muse-usage";
import { createClaudeAdapter } from "../providers/claude";

const now = new Date("2026-09-23T12:00:00Z");
const directories: string[] = [];
const context = () => ({ now, signal: new AbortController().signal, timeZone: "UTC" });

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "usageatlas-wsl-"));
  directories.push(home);
  return home;
}

async function writeJsonl(file: string, rows: unknown[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function codexSession(id: string, input: number, output: number) {
  return [
    { type: "session_meta", payload: { id } },
    { type: "event_msg", timestamp: now.toISOString(), payload: { type: "token_count",
      info: { model: "gpt-5.6-sol", last_token_usage: { input_tokens: input, output_tokens: output } } } }
  ];
}

function piSession(id: string, input: number, output: number) {
  return [
    { type: "session", version: 3, id, cwd: "/private/atlas", timestamp: now.toISOString() },
    { type: "message", id: "turn-1", timestamp: "2026-09-22T23:30:00Z", message: { role: "assistant",
      provider: "anthropic", model: "claude-sonnet-4-6",
      usage: { input, cacheRead: 0, cacheWrite: 0, output, totalTokens: input + output } } }
  ];
}

function seedOpenCode(databasePath: string, sessionID: string, input: number, output: number): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, data TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
  `);
  database.prepare("INSERT INTO session (id, directory, title, data) VALUES (?, ?, ?, ?)")
    .run(sessionID, "/projects/atlas", "Atlas", "{}");
  const created = now.valueOf() - 60 * 60 * 1_000;
  database.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
    `message-${sessionID}`, sessionID, created,
    JSON.stringify({ role: "assistant", providerID: "openai", modelID: "gpt-4.1",
      time: { created }, tokens: { input, output } })
  );
  database.close();
}

function museEvent(id: string) {
  return { schema_version: 1, record_type: "event", payload_type: "runtime.session", payload_schema_version: 1, id,
    recorded_at: Date.parse("2026-09-22T23:30:00Z") * 1000,
    payload: { event: { kind: "model_completed", model: "muse-spark-1.3-contributor-free",
      usage: { input_tokens: 100, output_tokens: 25 } } } };
}

describe("WSL homes join local scans", () => {
  it("adds Codex sessions from a second home", async () => {
    const primary = await makeHome(), wsl = await makeHome();
    await writeJsonl(path.join(primary, ".codex/sessions/a.jsonl"), codexSession("session-a", 10, 20));
    await writeJsonl(path.join(wsl, ".codex/sessions/b.jsonl"), codexSession("session-b", 5, 7));
    const scanner = new LocalUsageScanner({
      homeDirectory: primary, environment: { USAGEATLAS_WSL_HOMES: wsl }
    });
    const result = await scanner.scan("codex", context());
    expect(result.status).toBe("available");
    expect(result.totals).toMatchObject({ inputTokens: 15, outputTokens: 27, totalTokens: 42, requests: 2 });
  });

  it("counts a Codex session copied into both homes once", async () => {
    const primary = await makeHome(), wsl = await makeHome();
    await writeJsonl(path.join(primary, ".codex/sessions/a.jsonl"), codexSession("shared", 10, 20));
    await writeJsonl(path.join(wsl, ".codex/sessions/copy.jsonl"), codexSession("shared", 10, 20));
    const scanner = new LocalUsageScanner({
      homeDirectory: primary, environment: { USAGEATLAS_WSL_HOMES: wsl }
    });
    const result = await scanner.scan("codex", context());
    expect(result.status).toBe("available");
    expect(result.totals).toMatchObject({ totalTokens: 30, requests: 1 });
  });

  it("adds Pi sessions from a second home without double counting copies", async () => {
    const primary = await makeHome(), wsl = await makeHome();
    await writeJsonl(path.join(primary, ".pi/agent/sessions/a.jsonl"), piSession("pi-1", 100, 20));
    await writeJsonl(path.join(wsl, ".pi/agent/sessions/copy.jsonl"), piSession("pi-1", 100, 20));
    await writeJsonl(path.join(wsl, ".pi/agent/sessions/b.jsonl"), piSession("pi-2", 50, 10));
    const scanner = new JsonSessionUsageScanner("pi", {
      homeDirectory: primary, environment: { USAGEATLAS_WSL_HOMES: wsl }
    });
    const result = await scanner.scan(context());
    expect(result.status).toBe("available");
    expect(result.totals).toMatchObject({ inputTokens: 150, outputTokens: 30, requests: 2 });
  });

  it("merges OpenCode databases from both homes", async () => {
    const primary = await makeHome(), wsl = await makeHome();
    for (const [home, session, input, output] of [
      [primary, "session-1", 100, 50], [wsl, "session-2", 10, 3]
    ] as const) {
      const locations = openCodeLocations({ homeDirectory: home, environment: {} });
      await mkdir(locations.root, { recursive: true });
      seedOpenCode(locations.database, session, input, output);
    }
    const snapshot = await new OpenCodeUsageScanner({
      homeDirectory: primary, environment: { USAGEATLAS_WSL_HOMES: wsl }
    }).scan({ signal: new AbortController().signal, now });
    expect(snapshot.analytics.status).toBe("available");
    expect(snapshot.analytics.totals).toMatchObject({ inputTokens: 110, outputTokens: 53, requests: 2 });
  });

  it("counts a database shared by both homes once", async () => {
    const primary = await makeHome(), wsl = await makeHome();
    for (const home of [primary, wsl]) {
      const locations = openCodeLocations({ homeDirectory: home, environment: {} });
      await mkdir(locations.root, { recursive: true });
      seedOpenCode(locations.database, "shared-session", 100, 50);
    }
    const snapshot = await new OpenCodeUsageScanner({
      homeDirectory: primary, environment: { USAGEATLAS_WSL_HOMES: wsl }
    }).scan({ signal: new AbortController().signal, now });
    expect(snapshot.analytics.status).toBe("available");
    expect(snapshot.analytics.totals).toMatchObject({ inputTokens: 100, outputTokens: 50, requests: 1 });
  });

  it("reads the Claude sign-in from the WSL home when Windows has none", async () => {
    const primary = await makeHome(), wsl = await makeHome();
    await mkdir(path.join(wsl, ".claude"), { recursive: true });
    await writeFile(path.join(wsl, ".claude", ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "wsl-token", subscriptionType: "max" }
    }));
    let authorization = "", calls = 0;
    const fetch: typeof globalThis.fetch = (async (_url: unknown, init?: { headers?: unknown }) => {
      calls += 1;
      authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
      return Response.json(claudeFixture);
    }) as typeof globalThis.fetch;
    const result = await createClaudeAdapter({
      homeDirectory: primary, environment: { USAGEATLAS_WSL_HOMES: wsl }, fetch
    }).refresh({ signal: new AbortController().signal, now, historyDays: 90, historyDaysForAccount: () => 90 });
    expect(calls).toBe(1);
    expect(authorization).toBe("Bearer wsl-token");
    expect(result.windows).toHaveLength(2);
    expect(result.identity?.plan).toBe("max");
  });

  it("scans only the configured home when no extra homes are set", async () => {
    const primary = await makeHome();
    await writeJsonl(path.join(primary, ".codex/sessions/a.jsonl"), codexSession("solo", 10, 20));
    const scanner = new LocalUsageScanner({ homeDirectory: primary, environment: {} });
    const result = await scanner.scan("codex", context());
    expect(result.totals).toMatchObject({ totalTokens: 30, requests: 1 });
  });

  it("adds Muse sessions from a second home and counts copies once", async () => {
    const primary = await makeHome(), wsl = await makeHome();
    await writeJsonl(path.join(primary, ".local/share/muse/sessions/2026/09/22/session-a/session.jsonl"), [museEvent("muse-1")]);
    await writeJsonl(path.join(wsl, ".local/share/muse/sessions/2026/09/22/session-a/session.jsonl"), [museEvent("muse-1")]);
    await writeJsonl(path.join(wsl, ".local/share/muse/sessions/2026/09/22/session-b/session.jsonl"), [museEvent("muse-2")]);
    const scanner = new JsonSessionUsageScanner("muse", {
      homeDirectory: primary, environment: { USAGEATLAS_WSL_HOMES: wsl }
    });
    const result = await scanner.scan(context());
    expect(result.status).toBe("available");
    expect(result.totals.requests).toBe(2);
  });

  it("keeps a pinned Pi session directory to a single home", async () => {
    const primary = await makeHome(), wsl = await makeHome();
    const pinned = path.join(primary, "custom");
    await writeJsonl(path.join(pinned, "a.jsonl"), piSession("pi-1", 100, 20));
    await writeJsonl(path.join(wsl, ".pi/agent/sessions/b.jsonl"), piSession("pi-2", 50, 10));
    const scanner = new JsonSessionUsageScanner("pi", {
      homeDirectory: primary, environment: { USAGEATLAS_WSL_HOMES: wsl, PI_CODING_AGENT_SESSION_DIR: pinned }
    });
    const result = await scanner.scan(context());
    expect(result.status).toBe("available");
    expect(result.totals).toMatchObject({ inputTokens: 100, requests: 1 });
  });
});
