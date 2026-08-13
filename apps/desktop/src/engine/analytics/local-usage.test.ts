import claudeSession from "@usageatlas/contracts/fixtures/analytics/claude-session.json";
import codexSession from "@usageatlas/contracts/fixtures/analytics/codex-session.json";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalUsageScanner } from "./local-usage";
import { estimateClaudeCost, estimateCodexCost, normalizeCodexModel } from "./pricing";

const directories: string[] = [];
const now = new Date("2026-07-17T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local usage analytics", () => {
  it("reconstructs Codex totals, models, projects, sessions, tiers, and estimated cost", async () => {
    const home = await createHome();
    const sessions = path.join(home, ".codex", "sessions", "2026", "07", "17");
    await mkdir(sessions, { recursive: true });
    await writeJsonl(path.join(sessions, "fixture.jsonl"), codexSession);

    const analytics = await new LocalUsageScanner({ homeDirectory: home, environment: {} })
      .scan("codex", context());

    expect(analytics.status).toBe("available");
    expect(analytics.totals).toMatchObject({
      inputTokens: 450,
      cachedInputTokens: 650,
      cacheCreationInputTokens: 100,
      outputTokens: 130,
      totalTokens: 1_330,
      requests: 2,
      unpricedTokens: 0
    });
    expect(analytics.totals.estimatedCostUSD).toBeGreaterThan(0);
    expect(analytics.hourly).toHaveLength(1);
    expect(analytics.hourly?.[0]).toMatchObject({ totalTokens: 1330, requests: 2 });
    expect(analytics.models.map((model) => model.id)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
    expect(analytics.projects[0]?.label).toBe("sample-project");
    expect(analytics.sessions[0]?.id).toBe("codex-session-fixture");
    expect(analytics.serviceTiers.map((tier) => tier.id).sort()).toEqual(["priority", "standard"]);
    expect(analytics.coverageStart).toBe("2026-07-17");
    expect(analytics.coverageEnd).toBe("2026-07-17");
  });

  it("parses Claude cache categories and deduplicates copied messages", async () => {
    const home = await createHome();
    const projects = path.join(home, ".claude", "projects", "project-a");
    await mkdir(projects, { recursive: true });
    await writeJsonl(path.join(projects, "fixture.jsonl"), claudeSession);
    await writeJsonl(path.join(projects, "copied.jsonl"), claudeSession);

    const analytics = await new LocalUsageScanner({ homeDirectory: home, environment: {} })
      .scan("claude", context());

    expect(analytics.filesScanned).toBe(2);
    expect(analytics.recordsProcessed).toBe(2);
    expect(analytics.totals).toMatchObject({
      inputTokens: 500,
      cachedInputTokens: 75,
      cacheCreationInputTokens: 100,
      outputTokens: 70,
      totalTokens: 745,
      requests: 2,
      unpricedTokens: 0
    });
    expect(analytics.models.map((model) => model.id)).toEqual(["claude-sonnet-4-6", "claude-opus-4-6"]);
  });

  it("reports a healthy no-data state when no local session roots exist", async () => {
    const home = await createHome();
    const analytics = await new LocalUsageScanner({ homeDirectory: home, environment: {} })
      .scan("codex", context());
    expect(analytics.status).toBe("no_data");
    expect(analytics.error).toBeNull();
    expect(analytics.totals.totalTokens).toBe(0);
  });

  it("stays available when the newest session file ends on a half-written entry", async () => {
    const home = await createHome();
    const sessions = path.join(home, ".codex", "sessions", "2026", "07", "17");
    await mkdir(sessions, { recursive: true });
    const complete = codexSession.map((entry) => JSON.stringify(entry)).join("\n");
    await writeFile(path.join(sessions, "live.jsonl"), `${complete}\n{"type":"event_msg","payl`);

    const analytics = await new LocalUsageScanner({ homeDirectory: home, environment: {} })
      .scan("codex", context());

    expect(analytics.status).toBe("available");
    expect(analytics.error).toBeNull();
    expect(analytics.totals.totalTokens).toBe(1_330);
  });

  it("names the damaged entries instead of reporting an unexplained partial history", async () => {
    const home = await createHome();
    const sessions = path.join(home, ".codex", "sessions", "2026", "07", "17");
    await mkdir(sessions, { recursive: true });
    const complete = codexSession.map((entry) => JSON.stringify(entry)).join("\n");
    await writeFile(path.join(sessions, "damaged.jsonl"), `{"type":"event_msg","payl\n${complete}\n`);

    const analytics = await new LocalUsageScanner({ homeDirectory: home, environment: {} })
      .scan("codex", context());

    expect(analytics.status).toBe("partial");
    expect(analytics.error?.code).toBe("analytics_partial");
    expect(analytics.error?.message).toBe(
      "1 log entry could not be parsed. This usually clears on the next refresh; if it does not, those logs are damaged and deleting them restores the rest of the history."
    );
  });

  it("explains the file cap instead of blaming the logs when discovery is truncated", async () => {
    const home = await createHome();
    const sessions = path.join(home, ".codex", "sessions", "2026", "07", "17");
    await mkdir(sessions, { recursive: true });
    await writeJsonl(path.join(sessions, "a.jsonl"), codexSession);
    await writeJsonl(path.join(sessions, "b.jsonl"), codexSession);

    const analytics = await new LocalUsageScanner({ homeDirectory: home, environment: {}, maxFiles: 1 })
      .scan("codex", context());

    expect(analytics.status).toBe("partial");
    expect(analytics.error?.message).toBe(
      "More than 1 session files were found, so the oldest ones were not scanned. Delete or archive old session logs to bring the full history back."
    );
  });
});

describe("model pricing", () => {
  it("normalizes routed Codex model names and prices cached input as a subset", () => {
    expect(normalizeCodexModel("openai/gpt-5.6")).toBe("gpt-5.6-sol");
    expect(estimateCodexCost({
      model: "gpt-5.6-sol",
      inputTokens: 1_000,
      cachedInputTokens: 600,
      cacheCreationInputTokens: 0,
      outputTokens: 100
    })).toBeCloseTo(0.0053, 8);
  });

  it("prices Claude cache creation and cache reads independently", () => {
    expect(estimateClaudeCost({
      model: "claude-sonnet-4-6",
      inputTokens: 300,
      cachedInputTokens: 50,
      cacheCreationInputTokens: 100,
      cacheCreation1hInputTokens: 40,
      outputTokens: 40
    })).toBeCloseTo(0.00198, 8);
  });

  it("prices Codex cache writes, Fast service, and long context without inventing preview prices", () => {
    expect(estimateCodexCost({
      model: "gpt-5.6-sol",
      inputTokens: 1_000,
      cachedInputTokens: 600,
      cacheCreationInputTokens: 100,
      outputTokens: 100
    })).toBeCloseTo(0.005425, 8);
    expect(estimateCodexCost({
      model: "gpt-5.6-sol",
      inputTokens: 1_000,
      cachedInputTokens: 600,
      cacheCreationInputTokens: 0,
      outputTokens: 100,
      serviceTier: "priority"
    })).toBeCloseTo(0.0106, 8);
    expect(estimateCodexCost({
      model: "gpt-5.4-pro",
      inputTokens: 272_001,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 1
    })).toBeCloseTo(272_001 * 6e-5 + 2.7e-4, 8);
    expect(estimateCodexCost({
      model: "gpt-5.3-codex-spark",
      inputTokens: 1_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 100
    })).toBeNull();
  });

  it("uses Claude cache TTL, dated Sonnet 5, and Fast-mode prices", () => {
    expect(estimateClaudeCost({
      model: "claude-sonnet-5",
      inputTokens: 1_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 100,
      occurredAt: "2026-08-09T00:00:00.000Z"
    })).toBeCloseTo(0.003, 8);
    expect(estimateClaudeCost({
      model: "claude-sonnet-5",
      inputTokens: 1_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 100,
      occurredAt: "2026-09-01T00:00:00.000Z"
    })).toBeCloseTo(0.0045, 8);
    expect(estimateClaudeCost({
      model: "claude-opus-4-8",
      inputTokens: 300,
      cachedInputTokens: 50,
      cacheCreationInputTokens: 100,
      cacheCreation1hInputTokens: 40,
      outputTokens: 40,
      speed: "fast"
    })).toBeCloseTo(0.0066, 8);
  });
});

function context() {
  return { now, signal: new AbortController().signal };
}

async function createHome(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "usageatlas-analytics-"));
  directories.push(directory);
  return directory;
}

async function writeJsonl(file: string, entries: unknown[]): Promise<void> {
  await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}
