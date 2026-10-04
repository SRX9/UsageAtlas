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

  it("reads current usage from the v2 session tables", async () => {
    const home = await createHome();
    const locations = openCodeLocations({ homeDirectory: home, environment: {} });
    await mkdir(locations.root, { recursive: true });
    await writeFile(locations.auth, JSON.stringify({ "opencode-go": { type: "api", key: "secret" } }));
    const database = new DatabaseSync(locations.database);
    database.exec(`
      CREATE TABLE session_v2 (
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
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        type TEXT,
        seq INTEGER,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
    `);
    database.prepare(`
      INSERT INTO session_v2 (
        id, directory, title, model, cost, tokens_input, tokens_output,
        tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "session-v2",
      "C:\\projects\\v2",
      "V2",
      JSON.stringify({ id: "gpt-5.6", providerID: "opencode-go" }),
      4,
      400,
      80,
      8,
      200,
      50,
      now.valueOf() - 120_000,
      now.valueOf() - 60_000,
      "{}"
    );
    const created = now.valueOf() - 60 * 60 * 1_000;
    const insert = database.prepare(`
      INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    // The role lives in the `type` column and usage sits beside the tool calls.
    insert.run(
      "message-v2-1",
      "session-v2",
      "assistant",
      1,
      created,
      created,
      JSON.stringify({
        agent: "build",
        model: { id: "gpt-5.6", providerID: "opencode-go", variant: "max" },
        content: [{ type: "tool", name: "shell", state: { content: [{ type: "text", text: "ok" }] } }],
        finish: "tool-calls",
        cost: 4,
        tokens: { input: 400, output: 80, reasoning: 8, cache: { read: 200, write: 50 } },
        time: { created, completed: created + 1_000 }
      })
    );
    // Non-assistant turns must not become usage.
    insert.run(
      "message-v2-user",
      "session-v2",
      "user",
      0,
      created - 1_000,
      created - 1_000,
      JSON.stringify({ role: "user", text: "hello" })
    );
    database.close();

    const snapshot = await new OpenCodeUsageScanner({ homeDirectory: home, environment: {} })
      .scan({ signal: new AbortController().signal, now });

    expect(snapshot.hasGoPlan).toBe(true);
    expect(snapshot.analytics.status).toBe("available");
    expect(snapshot.analytics.totals).toMatchObject({
      inputTokens: 400,
      cachedInputTokens: 200,
      cacheCreationInputTokens: 50,
      outputTokens: 88,
      totalTokens: 738,
      requests: 1,
      estimatedCostUSD: 4
    });
    expect(snapshot.analytics.models.map((model) => model.id)).toEqual(["gpt-5.6"]);
    expect(snapshot.analytics.projects[0]?.label).toBe("v2");
    expect(snapshot.windows.map((window) => window.kind)).toEqual(["session", "weekly", "monthly"]);
    expect(snapshot.windows[0]?.usedPercent).toBeCloseTo(33.3, 1);
  });

  it("prefers the v2 tables over legacy tables that stopped advancing", async () => {
    const home = await createHome();
    const locations = openCodeLocations({ homeDirectory: home, environment: {} });
    await mkdir(locations.root, { recursive: true });
    const database = new DatabaseSync(locations.database);
    // A migrated install keeps the legacy tables around but frozen.
    database.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, model TEXT, cost REAL, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    const stale = now.valueOf() - 30 * 24 * 60 * 60 * 1_000;
    database.prepare("INSERT INTO session (id, directory, title, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run("session-legacy", "C:\\projects\\stale", "Stale", stale, stale, "{}");
    database.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
      "message-legacy",
      "session-legacy",
      stale,
      JSON.stringify({
        role: "assistant",
        providerID: "opencode",
        modelID: "legacy-model",
        time: { created: stale },
        tokens: { input: 1, output: 1 },
        cost: 99
      })
    );
    database.prepare("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)")
      .run("part-legacy", "message-legacy", stale, JSON.stringify({ type: "step-finish", tokens: { input: 1, output: 1 }, cost: 99 }));
    const fresh = now.valueOf() - 60 * 60 * 1_000;
    database.prepare("INSERT INTO session_v2 (id, directory, title, model, cost, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("session-current", "C:\\projects\\current", "Current", JSON.stringify({ id: "current-model", providerID: "opencode" }), 2, fresh, fresh, "{}");
    database.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        "message-current",
        "session-current",
        "assistant",
        1,
        fresh,
        fresh,
        JSON.stringify({
          model: { id: "current-model", providerID: "opencode" },
          cost: 2,
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: fresh }
        })
      );
    database.close();

    const snapshot = await new OpenCodeUsageScanner({ homeDirectory: home, environment: {} })
      .scan({ signal: new AbortController().signal, now });

    expect(snapshot.analytics.status).toBe("available");
    expect(snapshot.analytics.models.map((model) => model.id)).toEqual(["current-model"]);
    expect(snapshot.analytics.projects.map((project) => project.label)).toEqual(["current"]);
    expect(snapshot.analytics.totals.requests).toBe(1);
    expect(snapshot.analytics.totals.estimatedCostUSD).toBe(2);
  });

  it("skips unreadable usage payloads instead of failing the scan", async () => {
    const home = await createHome();
    const locations = openCodeLocations({ homeDirectory: home, environment: {} });
    await mkdir(locations.root, { recursive: true });
    const database = new DatabaseSync(locations.database);
    database.exec(`
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        type TEXT,
        seq INTEGER,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    const created = now.valueOf() - 60 * 60 * 1_000;
    const insert = database.prepare(`
      INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
      VALUES (?, 'session-broken', 'assistant', ?, ?, ?, ?)
    `);
    insert.run("broken", 1, created, created, "{not json");
    insert.run(
      "readable",
      2,
      created,
      created,
      JSON.stringify({
        model: { id: "gpt-5.6", providerID: "opencode" },
        cost: 1,
        tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created }
      })
    );
    database.close();

    const snapshot = await new OpenCodeUsageScanner({ homeDirectory: home, environment: {} })
      .scan({ signal: new AbortController().signal, now });

    expect(snapshot.analytics.totals).toMatchObject({
      requests: 1,
      totalTokens: 10,
      estimatedCostUSD: 1
    });
  });
});

async function createHome(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "usageatlas-opencode-"));
  directories.push(directory);
  return directory;
}
