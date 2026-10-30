import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { resolveFreebuffSources } from "./freebuff-paths";

const now = new Date("2026-10-26T18:00:00Z");
const SCHEMA = "seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, role TEXT NOT NULL, metrics_json TEXT NOT NULL DEFAULT '{}', ts INTEGER NOT NULL";

async function createDatabase(file: string, rows: Array<{ ts: number; metrics: unknown }> = []): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec(`CREATE TABLE messages (${SCHEMA})`);
  const insert = database.prepare("INSERT INTO messages (thread_id, role, metrics_json, ts) VALUES (?,?,?,?)");
  for (const row of rows) insert.run("thread-1", "assistant", JSON.stringify(row.metrics), row.ts);
  database.close();
  return file;
}

async function createForeignDatabase(file: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE messages (role TEXT NOT NULL, ts INTEGER NOT NULL)");
  database.close();
  return file;
}

async function createChat(file: string, messages: unknown[]): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(messages));
  const time = new Date(now.getTime() - 60_000);
  await utimes(file, time, time);
  return file;
}

async function entryFor(file: string): Promise<{ path: string; size: number; mtimeMs: number }> {
  const info = await stat(file);
  return { path: file, size: info.size, mtimeMs: info.mtimeMs };
}

async function writeRoute(
  cacheFile: string,
  databases: Array<{ path: string; size: number; mtimeMs: number }>,
  chats: Array<{ path: string; size: number; mtimeMs: number }> = [],
  resolvedAt = now.getTime()
): Promise<void> {
  await mkdir(path.dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, JSON.stringify({ version: 1, resolvedAt, roots: [], databases, chats }));
}

async function homeFixture(): Promise<{ home: string; cacheFile: string }> {
  const home = await mkdtemp(path.join(tmpdir(), "usageatlas-freebuff-route-"));
  return { home, cacheFile: path.join(home, "user-data", "freebuff-sources.json") };
}

describe("Freebuff path planner", () => {
  it("finds a database outside the canonical layout and saves the route", async () => {
    const { home, cacheFile } = await homeFixture();
    const database = await createDatabase(
      path.join(home, ".config", "freebuff-desktop", "workspaces", "app-7", "desktop-v2.db"),
      [{ ts: now.getTime(), metrics: { usage: { inputTokens: 5, outputTokens: 2 } } }]
    );
    const sources = await resolveFreebuffSources({ homeDirectory: home, cacheFile }, now);
    expect(sources.route).toBe("discovered");
    expect(sources.databases).toEqual([database]);
    const saved = JSON.parse(await readFile(cacheFile, "utf8")) as { databases: Array<{ path: string }> };
    expect(saved.databases.map(entry => entry.path)).toEqual([database]);
  });

  it("reuses a verified route without scanning again", async () => {
    const { home, cacheFile } = await homeFixture();
    const database = await createDatabase(path.join(home, "recorded", "desktop-v2.db"));
    await writeRoute(cacheFile, [await entryFor(database)]);
    const sources = await resolveFreebuffSources({ homeDirectory: home, cacheFile }, now);
    expect(sources.route).toBe("cached");
    expect(sources.databases).toEqual([database]);
    expect(sources.chats).toEqual([]);
  });

  it("re-plans and rewrites the route when a saved file disappears", async () => {
    const { home, cacheFile } = await homeFixture();
    await writeRoute(cacheFile, [{ path: path.join(home, "gone", "desktop-v2.db"), size: 100, mtimeMs: now.getTime() }]);
    const database = await createDatabase(path.join(home, ".config", "freebuff-desktop", "projects", "app-1", "desktop-v2.db"));
    const sources = await resolveFreebuffSources({ homeDirectory: home, cacheFile }, now);
    expect(sources.route).toBe("discovered");
    expect(sources.databases).toEqual([database]);
    const saved = JSON.parse(await readFile(cacheFile, "utf8")) as { databases: Array<{ path: string }> };
    expect(saved.databases.map(entry => entry.path)).toEqual([database]);
  });

  it("recovers from a corrupt or outdated cache file", async () => {
    const { home, cacheFile } = await homeFixture();
    const database = await createDatabase(path.join(home, ".config", "freebuff-desktop", "projects", "app-1", "desktop-v2.db"));
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, "{not json");
    expect((await resolveFreebuffSources({ homeDirectory: home, cacheFile }, now)).databases).toEqual([database]);
    await writeFile(cacheFile, JSON.stringify({ version: 99, resolvedAt: now.getTime(), roots: [], databases: [], chats: [] }));
    expect((await resolveFreebuffSources({ homeDirectory: home, cacheFile }, now)).route).toBe("discovered");
    expect(JSON.parse(await readFile(cacheFile, "utf8"))).toMatchObject({ version: 1 });
  });

  it("picks up a project that appeared after the saved route expired", async () => {
    const { home, cacheFile } = await homeFixture();
    const older = await createDatabase(path.join(home, ".config", "freebuff-desktop", "projects", "app-1", "desktop-v2.db"));
    await writeRoute(cacheFile, [await entryFor(older)], [], now.getTime() - 3_600_000);
    const newer = await createDatabase(path.join(home, ".config", "freebuff-desktop", "projects", "app-2", "desktop-v2.db"));
    const sources = await resolveFreebuffSources({ homeDirectory: home, cacheFile }, now);
    expect(sources.route).toBe("discovered");
    // Both projects count; same-millisecond writes make their order path-dependent.
    expect([...sources.databases].sort()).toEqual([newer, older].sort());
  });

  it("keeps a working saved route when a re-plan finds nothing", async () => {
    const { home, cacheFile } = await homeFixture();
    const database = await createDatabase(path.join(home, "recorded", "desktop-v2.db"));
    await writeRoute(cacheFile, [await entryFor(database)], [], now.getTime() - 3_600_000);
    const sources = await resolveFreebuffSources({ homeDirectory: home, cacheFile }, now);
    expect(sources.route).toBe("cached");
    expect(sources.databases).toEqual([database]);
    const saved = JSON.parse(await readFile(cacheFile, "utf8")) as { resolvedAt: number };
    expect(saved.resolvedAt).toBe(now.getTime());
  });

  it("drops a cached database whose schema no longer matches", async () => {
    const { home, cacheFile } = await homeFixture();
    const foreign = await createForeignDatabase(path.join(home, "recorded", "desktop-v2.db"));
    const chat = await createChat(
      path.join(home, ".config", "manicode", "projects", "app", "chats", "chat-1", "chat-messages.json"),
      [{ timestamp: "2026-10-26T10:00:00Z", credits: 3 }]
    );
    await writeRoute(cacheFile, [await entryFor(foreign)]);
    const sources = await resolveFreebuffSources({ homeDirectory: home, cacheFile }, now);
    expect(sources.route).toBe("discovered");
    expect(sources.databases).toEqual([]);
    expect(sources.chats).toEqual([chat]);
  });

  it("accepts a configured path that points straight at a file", async () => {
    const { home, cacheFile } = await homeFixture();
    const database = await createDatabase(path.join(home, "direct", "desktop-v2.db"));
    const environment = { FREEBUFF_CONFIG_DIR: database };
    const sources = await resolveFreebuffSources({ homeDirectory: home, cacheFile, environment }, now);
    expect(sources.databases).toEqual([database]);
  });

  it("rejects a relative config override instead of scanning the working directory", async () => {
    const { home, cacheFile } = await homeFixture();
    await expect(resolveFreebuffSources(
      { homeDirectory: home, cacheFile, environment: { FREEBUFF_CONFIG_DIR: "relative/path" } },
      now
    )).rejects.toMatchObject({ code: "config_invalid" });
  });
});
