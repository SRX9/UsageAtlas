import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../provider";
import { credentialLocations } from "./credentials";
import { fetchProviderJson } from "./http";
import { readCredentialJson } from "./json-file";
import { openWritableSqlite } from "./sqlite";
import { redactDiagnostic } from "./redaction";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("engine platform services", () => {
  it("checkpoints on a separate connection and closes it before reopening the database", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "usageatlas-checkpoint-")); directories.push(directory);
    const file = path.join(directory, "history.sqlite");
    const db = openWritableSqlite(file);
    try {
      await vi.waitFor(() => expect(db.get("PRAGMA wal_autocheckpoint")?.wal_autocheckpoint).toBe(0));
      expect(db.get("PRAGMA synchronous")?.synchronous).toBe(2);
      db.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)");
      await db.commit(Array.from({ length: 1000 }, (_, i) => ({ sql: "INSERT INTO sample VALUES (?, ?)", parameters: [i, "x".repeat(1024)] })));
      await expect(db.commit([
        { sql: "INSERT INTO sample VALUES (?, ?)", parameters: [1000, "rollback"] },
        { sql: "INSERT INTO missing_table VALUES (1)", parameters: [] }
      ])).rejects.toThrow();
      expect(db.get("SELECT count(*) AS count FROM sample")?.count).toBe(1000);
    } finally { await db.close(); }
    const reopened = openWritableSqlite(file);
    try {
      expect(reopened.get("SELECT count(*) AS count FROM sample")?.count).toBe(1000);
      expect(reopened.get("PRAGMA integrity_check")?.integrity_check).toBe("ok");
    } finally { await reopened.close(); }
  });

  it("resolves the Claude credential override on every platform", () => {
    const locations = credentialLocations(
      { CLAUDE_CONFIG_DIR: "C:\\profiles\\claude" },
      "C:\\ignored"
    );
    expect(path.basename(locations.claude)).toBe(".credentials.json");
  });

  it("reads bounded credential JSON without exposing its path in errors", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "usageatlas-credentials-"));
    directories.push(directory);
    const file = path.join(directory, "auth.json");
    await writeFile(file, JSON.stringify({ token: "fixture" }));
    await expect(readCredentialJson(file, "Codex")).resolves.toEqual({ token: "fixture" });
    await expect(readCredentialJson(path.join(directory, "missing.json"), "Codex"))
      .rejects.not.toThrow(directory);
  });

  it("maps HTTP authentication and server errors without response bodies", async () => {
    const unauthorized = vi.fn<typeof fetch>(async () => new Response("secret body", { status: 401 }));
    await expect(fetchProviderJson("Codex", "https://example.invalid", {}, unauthorized))
      .rejects.toMatchObject({ code: "auth_required", retryable: false } satisfies Partial<ProviderError>);

    const failed = vi.fn<typeof fetch>(async () => new Response("private body", { status: 503 }));
    await expect(fetchProviderJson("Codex", "https://example.invalid", {}, failed))
      .rejects.toMatchObject({ code: "provider_error", retryable: true } satisfies Partial<ProviderError>);
  });

  it("redacts common secret and identity forms", () => {
    const value = redactDiagnostic("Authorization: bearer-token user@example.com cookie=session-value");
    expect(value).not.toContain("bearer-token");
    expect(value).not.toContain("user@example.com");
    expect(value).not.toContain("session-value");
  });
});
