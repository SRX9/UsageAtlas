import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../provider";
import { credentialLocations } from "./credentials";
import { fetchProviderJson } from "./http";
import { readCredentialJson } from "./json-file";
import { redactDiagnostic } from "./redaction";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("engine platform services", () => {
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
