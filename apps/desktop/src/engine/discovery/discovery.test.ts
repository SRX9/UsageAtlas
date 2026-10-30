import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { nameVariants, namesRelated } from "./names";
import { candidateFileKind } from "./patterns";
import { probeFile } from "./probe";
import { candidateRoots } from "./roots";
import { discoverProviderUsage } from "./route";
import { CATALOG } from "./catalog";

const now = new Date("2026-10-26T18:00:00Z");

async function home(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "usageatlas-discovery-"));
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

function tokenDatabase(file: string): void {
  const database = new DatabaseSync(file);
  database.exec(`CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL
  )`);
  const insert = database.prepare("INSERT INTO usage (created_at, prompt_tokens, completion_tokens, total_tokens) VALUES (?,?,?,?)");
  insert.run("2026-10-26T10:00:00Z", 100, 20, 120);
  insert.run("2026-10-26T11:00:00Z", 10, 5, 15);
  database.close();
}

function blobDatabase(file: string): void {
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, metrics_json TEXT NOT NULL)");
  database.prepare("INSERT INTO messages (ts, metrics_json) VALUES (?,?)")
    .run(Date.parse("2026-10-26T10:00:00Z"), JSON.stringify({ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }));
  database.close();
}

describe("provider discovery", () => {
  it("spells a product name the ways an installer would", () => {
    expect(nameVariants("CodeFree").slug).toBe("codefree");
    expect(nameVariants("CodeFree").variants).toEqual(expect.arrayContaining(["codefree", "codefree-desktop", "codefree-cli"]));
    expect(nameVariants("z.ai").variants).toEqual(expect.arrayContaining(["z-ai", "zai", "z.ai"]));
    expect(namesRelated("codefree-desktop", "codefree")).toBe(true);
    expect(namesRelated("CodeFree Studio", "codefree")).toBe(true);
    expect(namesRelated("ai", "z.ai")).toBe(false); // too short to be evidence
    expect(namesRelated("Code", "codefree")).toBe(false); // a shared prefix is not the same product
  });

  it("offers a catalog of at least 250 distinct providers", () => {
    const names = new Set(CATALOG.map(entry => entry.name));
    expect(names.size).toBeGreaterThanOrEqual(250);
    for (const entry of CATALOG) expect(nameVariants(entry.name).slug.length).toBeGreaterThan(1);
  });

  it("reports an unknown provider with no store in under two seconds, offline", async () => {
    const directory = await home();
    const started = performance.now();
    const result = await discoverProviderUsage("zzz-not-installed-9981", now, {
      homeDirectory: directory,
      environment: {} as NodeJS.ProcessEnv,
      cacheDirectory: null,
      maxEntries: 4_000
    });
    expect(result.files).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
    await rm(directory, { recursive: true, force: true });
  });

  it("offers a config root per platform data folder", () => {
    const roots = candidateRoots("codefree", { homeDirectory: "/home/me", environment: {} as NodeJS.ProcessEnv });
    expect(roots).toContain(path.join("/home/me", ".config", "codefree"));
    expect(roots).toContain(path.join("/home/me", "Library", "Application Support", "codefree-desktop"));
  });

  it("only treats accounting-looking documents as candidates", () => {
    expect(candidateFileKind("usage.json")).toBe("document");
    expect(candidateFileKind("token-usage-2026.jsonl")).toBe("document");
    expect(candidateFileKind("desktop-v2.db")).toBe("database");
    expect(candidateFileKind("settings.json")).toBeNull();
    expect(candidateFileKind("logo.png")).toBeNull();
    // Claude Code names transcripts by session id, so only the probe can tell.
    expect(candidateFileKind("0f3c1a2e-1111-2222-3333-444455556666.jsonl")).toBe("document");
  });

  it("probes SQLite columns, JSON blobs, documents and event logs", async () => {
    const root = await home();
    const columns = path.join(root, "columns.db");
    tokenDatabase(columns);
    const blob = path.join(root, "blob.db");
    blobDatabase(blob);
    const document = path.join(root, "usage.json");
    await writeJson(document, { model: "gpt-x", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    const events = path.join(root, "events.jsonl");
    await writeFile(events, [
      JSON.stringify({ ts: "2026-10-26T10:00:00Z", usage: { input_tokens: 3, output_tokens: 4 } }),
      JSON.stringify({ ts: "2026-10-26T11:00:00Z", usage: { input_tokens: 6, output_tokens: 2 } }),
      ""
    ].join("\n"));

    expect(await probeFile(columns, "database")).toMatchObject({
      usable: true, shape: { kind: "sqlite", fields: expect.arrayContaining(["prompt_tokens", "completion_tokens"]) }
    });
    expect(await probeFile(blob, "database")).toMatchObject({
      usable: true, confidence: 0.93, shape: { kind: "sqlite", location: "messages.metrics_json" }
    });
    expect(await probeFile(document, "document")).toMatchObject({ usable: true, shape: { kind: "json" } });
    expect(await probeFile(events, "document")).toMatchObject({ usable: true, shape: { kind: "jsonl" } });
  });

  it("rejects files that only look like usage", async () => {
    const root = await home();
    const settings = path.join(root, "settings.json");
    await writeJson(settings, { theme: "dark", window: { width: 800, height: 600 } });
    expect(await probeFile(settings, "document")).toMatchObject({ usable: false });

    const empty = path.join(root, "empty.db");
    await writeFile(empty, "not a database");
    expect(await probeFile(empty, "database")).toMatchObject({ usable: false });
  });

  it("finds a provider's usage from its name alone and remembers the route", async () => {
    const root = await home();
    const usage = path.join(root, ".config", "codefree", "usage.json");
    await writeJson(usage, { usage: { prompt_tokens: 12, completion_tokens: 3 } });
    await writeJson(path.join(root, ".config", "codefree", "settings.json"), { theme: "dark" });

    const cacheDirectory = path.join(root, "userdata");
    const first = await discoverProviderUsage("codefree", now, { homeDirectory: root, environment: {} as NodeJS.ProcessEnv, cacheDirectory });
    expect(first.route).toBe("discovered");
    expect(first.files.map(file => file.path)).toEqual([usage]);

    const second = await discoverProviderUsage("codefree", now, { homeDirectory: root, environment: {} as NodeJS.ProcessEnv, cacheDirectory });
    expect(second.route).toBe("cached");
    expect(second.files.map(file => file.path)).toEqual([usage]);
    const saved = JSON.parse(await readFile(path.join(cacheDirectory, "discovered-codefree.json"), "utf8")) as { files: unknown[] };
    expect(saved.files).toHaveLength(1);
  });

  it("revisits the remembered folder and picks up a ledger that appeared later", async () => {
    const root = await home();
    const first = path.join(root, ".config", "codefree", "usage.json");
    await writeJson(first, { usage: { prompt_tokens: 8, completion_tokens: 2 } });
    const options = { homeDirectory: root, environment: {} as NodeJS.ProcessEnv, cacheDirectory: path.join(root, "userdata") };
    expect((await discoverProviderUsage("codefree", now, options)).files).toHaveLength(1);

    const second = path.join(root, ".config", "codefree", "usage-2026.json");
    await writeJson(second, { usage: { input_tokens: 30, output_tokens: 4 } });
    const revisited = await discoverProviderUsage("codefree", now, options);
    expect(revisited.route).toBe("cached");
    expect(revisited.files.map(file => file.path)).toEqual(expect.arrayContaining([first, second]));
    expect(revisited.files).toHaveLength(2);
    const saved = JSON.parse(await readFile(path.join(root, "userdata", "discovered-codefree.json"), "utf8")) as { files: unknown[] };
    expect(saved.files).toHaveLength(2);
  });

  it("checks sibling folders even after a ledger was found", async () => {
    const root = await home();
    const primary = path.join(root, ".config", "codefree", "usage.json");
    const sibling = path.join(root, ".config", "CodeFree Studio", "usage.json");
    await writeJson(primary, { usage: { prompt_tokens: 5, completion_tokens: 5 } });
    await writeJson(sibling, { usage: { input_tokens: 11, output_tokens: 6 } });

    const result = await discoverProviderUsage("codefree", now, {
      homeDirectory: root, environment: {} as NodeJS.ProcessEnv, cacheDirectory: null
    });
    expect(result.related).toEqual([path.join(root, ".config", "CodeFree Studio")]);
    expect(result.files.map(file => file.path)).toEqual(expect.arrayContaining([primary, sibling]));
    expect(result.files).toHaveLength(2);
  });

  it("plans again as soon as the saved route stops verifying", async () => {
    const root = await home();
    const usage = path.join(root, ".config", "codefree", "usage.json");
    await writeJson(usage, { usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const options = { homeDirectory: root, environment: {} as NodeJS.ProcessEnv, cacheDirectory: path.join(root, "userdata") };
    expect((await discoverProviderUsage("codefree", now, options)).files).toHaveLength(1);

    await rm(usage);
    const afterRemoval = await discoverProviderUsage("codefree", now, options);
    expect(afterRemoval.route).toBe("discovered");
    expect(afterRemoval.files).toEqual([]);
  });

  it("falls back to a related folder when the exact address does not exist", async () => {
    const root = await home();
    const usage = path.join(root, ".config", "CodeFree Studio", "usage.json");
    await writeJson(usage, { usage: { input_tokens: 40, output_tokens: 2 } });

    const result = await discoverProviderUsage("codefree", now, {
      homeDirectory: root, environment: {} as NodeJS.ProcessEnv, cacheDirectory: null
    });
    expect(result.related).toEqual([path.join(root, ".config", "CodeFree Studio")]);
    expect(result.files.map(file => file.path)).toEqual([usage]);
  });

  it("finds a uuid-named transcript by probing its content", async () => {
    const root = await home();
    const transcript = path.join(root, ".claude", "projects", "my-app", "0f3c1a2e-1111-2222-3333-444455556666.jsonl");
    await mkdir(path.dirname(transcript), { recursive: true });
    await writeFile(transcript, [
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 1200, output_tokens: 340 } } }),
      JSON.stringify({ type: "user" }),
      ""
    ].join("\n"));
    const result = await discoverProviderUsage("claude", now, {
      homeDirectory: root, environment: {} as NodeJS.ProcessEnv, cacheDirectory: null
    });
    expect(result.related).toContain(path.join(root, ".claude"));
    expect(result.files.map(file => file.path)).toEqual([transcript]);
  });

  it("still finds the needle in a large tree", async () => {
    const root = await home();
    for (let index = 0; index < 200; index += 1) {
      await writeJson(path.join(root, ".config", "codefree", "chunks", `part-${index}.json`), { index });
    }
    const usage = path.join(root, ".config", "codefree", "usage.json");
    await writeJson(usage, { usage: { prompt_tokens: 2, completion_tokens: 2 } });
    const result = await discoverProviderUsage("codefree", now, {
      homeDirectory: root, environment: {} as NodeJS.ProcessEnv, cacheDirectory: null
    });
    expect(result.files.map(file => file.path)).toEqual([usage]);
  });
});
