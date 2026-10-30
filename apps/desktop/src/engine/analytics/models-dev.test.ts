import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODELS_DEV_URL,
  loadPricingCatalog,
  modelsDevCachePath,
  parseModelsDevCatalog,
  pricingCatalogFromRates
} from "./models-dev";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("models.dev catalog", () => {
  it("uses the rate content as its revision instead of cache download time", () => {
    const source = { openai: { models: { future: { cost: { input: 1, output: 2 } } } } };
    expect(parseModelsDevCatalog(source, "yesterday").revision).toBe(parseModelsDevCatalog(source, "today").revision);
    expect(parseModelsDevCatalog({ openai: { models: { future: { cost: { input: 1, output: 3 } } } } }).revision)
      .not.toBe(parseModelsDevCatalog(source).revision);
  });
  it("converts per-million rates and long-context tiers", () => {
    const catalog = parseModelsDevCatalog({
      anthropic: {
        models: {
          "claude-opus-5": {
            cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 }
          }
        }
      },
      openai: {
        models: {
          "gpt-new": {
            cost: {
              input: 5,
              output: 30,
              cache_read: 0.5,
              cache_write: 6.25,
              tiers: [{
                input: 10,
                output: 45,
                cache_read: 1,
                cache_write: 12.5,
                tier: { type: "context", size: 272_000 }
              }]
            }
          }
        }
      }
    });

    expect(catalog.rate("anthropic", "claude-opus-5")).toEqual({
      input: 5e-6,
      output: 2.5e-5,
      cacheRead: 5e-7,
      cacheWrite: 6.25e-6
    });
    expect(catalog.rate("openai", "gpt-new")).toMatchObject({
      input: 5e-6,
      output: 3e-5,
      cacheRead: 5e-7,
      cacheWrite: 6.25e-6,
      threshold: 272_000,
      inputAboveThreshold: 1e-5,
      outputAboveThreshold: 4.5e-5
    });
    expect(catalog.rate("anthropic", "missing")).toBeNull();
  });

  it("finds the rate of a tool's own vendor prefix under the publishing provider", () => {
    // Freebuff routes `z-ai/glm-5.3-flash`; models.dev publishes it as zhipuai.
    const catalog = pricingCatalogFromRates({
      zhipuai: { "glm-5.3-flash": { input: 1.1952e-7, output: 4.1831e-7 } },
      mistral: { "codestral-2508": { input: 3e-7, output: 9e-7 } },
      zai: { "glm-5.3-flash": { input: 9e-7, output: 9e-7 } }
    });
    expect(catalog.rate("z-ai", "glm-5.3-flash")?.input).toBe(1.1952e-7);
    expect(catalog.rate("mistralai", "codestral-2508")?.output).toBe(9e-7);
    // A provider key the catalog carries itself still wins over an alias.
    expect(catalog.rate("zai", "glm-5.3-flash")?.input).toBe(9e-7);
    // An unmapped prefix, or a model nobody publishes, stays unpriced.
    expect(catalog.rate("stealth", "ox-alpha")).toBeNull();
    expect(catalog.rate("z-ai", "glm-5.4")).toBeNull();
  });

  it("refreshes a stale cache and reuses a fresh one without fetching", async () => {
    const home = await createHome();
    const now = new Date("2026-08-14T12:00:00.000Z");
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({
      anthropic: {
        models: {
          "claude-opus-5": { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } }
        }
      }
    }));

    const first = await loadPricingCatalog({
      homeDirectory: home,
      fetch: fetchImplementation,
      signal: new AbortController().signal,
      now
    });
    expect(first.rate("anthropic", "claude-opus-5")?.input).toBe(5e-6);
    expect(fetchImplementation).toHaveBeenCalledWith(MODELS_DEV_URL, expect.anything());

    const second = await loadPricingCatalog({
      homeDirectory: home,
      fetch: fetchImplementation,
      signal: new AbortController().signal,
      now: new Date("2026-08-14T18:00:00.000Z")
    });
    expect(second.revision).toBe(first.revision);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    const cache = JSON.parse(await readFile(modelsDevCachePath(home), "utf8")) as { fetchedAt: string };
    expect(cache.fetchedAt).toBe("2026-08-14T12:00:00.000Z");
  });

  it("keeps the last good cache when a refresh fails", async () => {
    const home = await createHome();
    await mkdir(path.dirname(modelsDevCachePath(home)), { recursive: true });
    const catalog = pricingCatalogFromRates({
      anthropic: { "claude-opus-5": { input: 5e-6, output: 2.5e-5 } }
    });
    expect(catalog.rate("anthropic", "claude-opus-5")?.input).toBe(5e-6);

    const first = await loadPricingCatalog({
      homeDirectory: home,
      fetch: vi.fn<typeof fetch>(async () => Response.json({
        anthropic: { models: { "claude-opus-5": { cost: { input: 5, output: 25 } } } }
      })),
      signal: new AbortController().signal,
      now: new Date("2026-08-01T00:00:00.000Z")
    });
    expect(first.rate("anthropic", "claude-opus-5")?.input).toBe(5e-6);

    const stale = await loadPricingCatalog({
      homeDirectory: home,
      fetch: vi.fn<typeof fetch>(async () => {
        throw new Error("offline");
      }),
      signal: new AbortController().signal,
      now: new Date("2026-08-14T00:00:00.000Z")
    });
    expect(stale.rate("anthropic", "claude-opus-5")?.input).toBe(5e-6);
  });
});

async function createHome(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "usageatlas-models-dev-"));
  directories.push(directory);
  return directory;
}
