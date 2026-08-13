import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeUsageScanner, openCodeLocations } from "./opencode-usage";

const directories: string[] = [];
const now = new Date("2026-07-20T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("OpenCode local usage", () => {
  it("maps message and step usage into analytics and OpenCode Go windows", async () => {
    const home = await createHome();
    const locations = openCodeLocations({ homeDirectory: home, environment: {} });
    await mkdir(locations.root, { recursive: true });
    await writeFile(locations.auth, JSON.stringify({ "opencode-go": { type: "api", key: "secret" } }));
    const database = new DatabaseSync(locations.database);
    database.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, data TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);
    `);
    database.prepare("INSERT INTO session (id, directory, title, data) VALUES (?, ?, ?, ?)")
      .run("session-1", "C:\\projects\\atlas", "Atlas", "{}");
    const firstTime = now.valueOf() - 60 * 60 * 1_000;
    database.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
      "message-1",
      "session-1",
      firstTime,
      JSON.stringify({
        role: "assistant",
        providerID: "opencode-go",
        modelID: "gpt-5.6",
        time: { created: firstTime },
        tokens: { input: 100, output: 50, reasoning: 5, cache: { read: 20, write: 10 } },
        cost: 3
      })
    );
    database.prepare("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)").run(
      "part-aggregate-preferred",
      "message-1",
      firstTime,
      JSON.stringify({
        type: "step-finish",
        tokens: { input: 100, output: 50, reasoning: 5, cache: { read: 20, write: 10 } },
        cost: 3
      })
    );
    const secondTime = now.valueOf() - 30 * 60 * 1_000;
    database.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
      "message-2",
      "session-1",
      secondTime,
      JSON.stringify({
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-4.1",
        time: { created: secondTime }
      })
    );
    database.prepare("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)").run(
      "part-1",
      "message-2",
      secondTime,
      JSON.stringify({ type: "step-finish", tokens: { input: 10, output: 3 }, cost: 0.5 })
    );
    database.close();

    const snapshot = await new OpenCodeUsageScanner({ homeDirectory: home, environment: {} })
      .scan({ signal: new AbortController().signal, now });

    expect(snapshot.hasGoPlan).toBe(true);
    expect(snapshot.analytics.status).toBe("available");
    expect(snapshot.analytics.totals).toMatchObject({
      inputTokens: 110,
      cachedInputTokens: 20,
      cacheCreationInputTokens: 10,
      outputTokens: 58,
      totalTokens: 198,
      requests: 2,
      estimatedCostUSD: 3.5
    });
    expect(snapshot.analytics.models.map((model) => model.id)).toEqual(["gpt-5.6", "gpt-4.1"]);
    expect(snapshot.analytics.projects[0]?.label).toBe("atlas");
    expect(snapshot.windows.map((window) => window.kind)).toEqual(["session", "weekly", "monthly"]);
    expect(snapshot.windows[0]?.usedPercent).toBe(25);
    expect(snapshot.windows[0]?.remainingPercent).toBe(75);
  });

  it("falls back to current OpenCode session aggregate columns when granular rows are absent", async () => {
    const home = await createHome();
    const locations = openCodeLocations({ homeDirectory: home, environment: {} });
    await mkdir(locations.root, { recursive: true });
    const database = new DatabaseSync(locations.database);
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT,
        title TEXT,
        model TEXT,
        cost REAL,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);
    `);
    database.prepare(`
      INSERT INTO session (
        id, directory, title, model, cost, tokens_input, tokens_output,
        tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "session-aggregate",
      "C:\\projects\\fallback",
      "Fallback",
      JSON.stringify({ id: "claude-sonnet-4-6", providerID: "anthropic" }),
      1.25,
      1_000,
      200,
      25,
      500,
      100,
      now.valueOf() - 60_000,
      now.valueOf() - 30_000,
      "{}"
    );
    database.close();

    const snapshot = await new OpenCodeUsageScanner({ homeDirectory: home, environment: {} })
      .scan({ signal: new AbortController().signal, now });

    expect(snapshot.analytics.totals).toMatchObject({
      inputTokens: 1_000,
      cachedInputTokens: 500,
      cacheCreationInputTokens: 100,
      outputTokens: 225,
      totalTokens: 1_825,
      requests: 1,
      estimatedCostUSD: 1.25
    });
    expect(snapshot.analytics.models[0]?.id).toBe("claude-sonnet-4-6");
    expect(snapshot.analytics.projects[0]?.label).toBe("fallback");
  });

  it("resolves an XDG data override without reading the real home", () => {
    expect(openCodeLocations({
      environment: { XDG_DATA_HOME: "C:\\xdg-data" },
      homeDirectory: "C:\\home"
    }).database).toBe(path.resolve("C:\\xdg-data", "opencode", "opencode.db"));
  });
});

async function createHome(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "usageatlas-opencode-"));
  directories.push(directory);
  return directory;
}
