import claudeSession from "@usageatlas/contracts/fixtures/analytics/claude-session.json";
import codexSession from "@usageatlas/contracts/fixtures/analytics/codex-session.json";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalUsageScanner } from "./local-usage";
import { pricingCatalogFromRates } from "./models-dev";
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
    // Day-scoped views split the same totals by model, so the per-day rows have to add
    // back up to the whole-coverage ones.
    expect(analytics.dailyModels.map((row) => [row.date, row.id, row.totalTokens])).toEqual(
      analytics.models.map((model) => ["2026-07-17", model.id, model.totalTokens])
    );
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

  it("reads the Codex model from world_state when turn_context has not appeared yet", async () => {
    const home = await createHome();
    const sessions = path.join(home, ".codex", "sessions", "2026", "07", "17");
    await mkdir(sessions, { recursive: true });
    await writeJsonl(path.join(sessions, "world-state.jsonl"), [
      {
        type: "world_state",
        timestamp: "2026-07-17T08:00:00.000Z",
        payload: { state: { model: "gpt-5.6-sol" } }
      },
      {
        type: "event_msg",
        timestamp: "2026-07-17T08:01:00.000Z",
        payload: {
          type: "token_count",
          turn_id: "turn-one",
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              output_tokens: 10
            }
          }
        }
      }
    ]);

    const analytics = await new LocalUsageScanner({ homeDirectory: home, environment: {} })
      .scan("codex", context());

    expect(analytics.models.map((model) => model.id)).toEqual(["gpt-5.6-sol"]);
    expect(analytics.totals.unpricedTokens).toBe(0);
    expect(analytics.totals.estimatedCostUSD).toBeGreaterThan(0);
  });

  it("prices a model that exists only in the live catalog", async () => {
    const home = await createHome();
    const projects = path.join(home, ".claude", "projects", "project-a");
    await mkdir(projects, { recursive: true });
    await writeJsonl(path.join(projects, "new-model.jsonl"), [{
      type: "assistant",
      timestamp: "2026-07-17T09:00:00.000Z",
      sessionId: "claude-new",
      cwd: "D:\\work\\sample-project",
      message: {
        id: "msg_new",
        model: "claude-future-9",
        usage: {
          input_tokens: 1000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 100,
          speed: "standard"
        }
      }
    }]);

    const analytics = await new LocalUsageScanner({
      homeDirectory: home,
      environment: {},
      pricingCatalogLoader: async () => pricingCatalogFromRates({
        anthropic: {
          "claude-future-9": { input: 1e-6, output: 5e-6, cacheWrite: 1.25e-6, cacheRead: 1e-7 }
        }
      }, "live")
    }).scan("claude", context());

    expect(analytics.totals.unpricedTokens).toBe(0);
    expect(analytics.totals.estimatedCostUSD).toBeCloseTo(0.0015, 8);
  });

  it("publishes the priced subtotal when a session also contains an unknown model", async () => {
    const home = await createHome();
    const projects = path.join(home, ".claude", "projects", "project-a");
    await mkdir(projects, { recursive: true });
    await writeJsonl(path.join(projects, "mixed.jsonl"), [
      ...claudeSession,
      {
        type: "assistant",
        timestamp: "2026-07-17T09:02:00.000Z",
        sessionId: "claude-session-fixture",
        cwd: "D:\\work\\sample-project",
        message: {
          id: "msg_unknown",
          model: "claude-not-in-table-yet",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 0,
            output_tokens: 10,
            speed: "standard"
          }
        }
      }
    ]);

    const analytics = await new LocalUsageScanner({ homeDirectory: home, environment: {} })
      .scan("claude", context());

    expect(analytics.totals.unpricedTokens).toBe(110);
    expect(analytics.totals.estimatedCostUSD).toBeGreaterThan(0);
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

  it("prices Codex cache writes, Fast service, and long context, and treats preview models as free", () => {
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
      model: "gpt-5",
      inputTokens: 1_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 100,
      outputTokens: 100
    })).toBeCloseTo(1_000 * 1.25e-6 + 100 * 1e-5, 8);
    expect(estimateCodexCost({
      model: "gpt-5.3-codex-spark",
      inputTokens: 1_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 100
    })).toBe(0);
    expect(estimateCodexCost({
      model: "codex-auto-review",
      inputTokens: 1_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 100
    })).toBe(0);
  });

  it("prices Claude Opus 5, Fast mode, and current Sonnet 5 list rates", () => {
    expect(estimateClaudeCost({
      model: "claude-opus-5",
      inputTokens: 1_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 100
    })).toBeCloseTo(0.0075, 8);
    expect(estimateClaudeCost({
      model: "claude-sonnet-5",
      inputTokens: 1_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 100
    })).toBeCloseTo(0.003, 8);
    expect(estimateClaudeCost({
      model: "claude-opus-5",
      inputTokens: 300,
      cachedInputTokens: 50,
      cacheCreationInputTokens: 100,
      cacheCreation1hInputTokens: 40,
      outputTokens: 40,
      speed: "fast"
    })).toBeCloseTo(0.0066, 8);
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

  it("uses a live catalog for models that are not in the bundled table", () => {
    const catalog = pricingCatalogFromRates({
      anthropic: {
        "claude-future-9": { input: 1e-6, output: 5e-6, cacheWrite: 1.25e-6, cacheRead: 1e-7 }
      },
      openai: {
        "gpt-future": { input: 2e-6, output: 1e-5, cacheRead: 2e-7 }
      }
    });
    expect(estimateClaudeCost({
      model: "claude-future-9",
      inputTokens: 1_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 100
    }, catalog)).toBeCloseTo(0.0015, 8);
    expect(estimateCodexCost({
      model: "gpt-future",
      inputTokens: 1_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 100
    }, catalog)).toBeCloseTo(0.003, 8);
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
