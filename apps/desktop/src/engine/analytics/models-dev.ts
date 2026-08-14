import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const MODELS_DEV_PROVIDER_OPENAI = "openai";
export const MODELS_DEV_PROVIDER_ANTHROPIC = "anthropic";

const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAXIMUM_BYTES = 8 * 1_024 * 1_024;

let memory: { cachePath: string; fetchedAt: string; catalog: PricingCatalog } | null = null;

export interface ModelRate {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  threshold?: number;
  inputAboveThreshold?: number;
  outputAboveThreshold?: number;
  cacheReadAboveThreshold?: number;
  cacheWriteAboveThreshold?: number;
}

export interface PricingCatalog {
  revision: string;
  rate(providerID: string, modelID: string): ModelRate | null;
}

interface CacheFile {
  fetchedAt: string;
  catalog: unknown;
}

export type FetchImplementation = typeof fetch;

export function emptyPricingCatalog(revision = "bundled"): PricingCatalog {
  return pricingCatalogFromRates({}, revision);
}

export function pricingCatalogFromRates(
  rates: Readonly<Record<string, Readonly<Record<string, ModelRate>>>>,
  revision = "test"
): PricingCatalog {
  return {
    revision,
    rate(providerID, modelID) {
      return rates[providerID]?.[modelID] ?? null;
    }
  };
}

export function parseModelsDevCatalog(value: unknown, revision = "models-dev"): PricingCatalog {
  const root = record(value);
  const rates: Record<string, Record<string, ModelRate>> = {};
  if (!root) return pricingCatalogFromRates(rates, revision);
  for (const [providerID, provider] of Object.entries(root)) {
    const models = record(record(provider)?.models);
    if (!models) continue;
    const providerRates: Record<string, ModelRate> = {};
    for (const [modelID, model] of Object.entries(models)) {
      const rate = parseModelRate(record(model)?.cost);
      if (rate) providerRates[modelID] = rate;
    }
    if (Object.keys(providerRates).length > 0) rates[providerID] = providerRates;
  }
  return pricingCatalogFromRates(rates, revision);
}

export function createPricingCatalogLoader(options: {
  homeDirectory: string;
  fetch?: FetchImplementation;
}): (context: { signal: AbortSignal; now: Date }) => Promise<PricingCatalog> {
  let inflight: Promise<PricingCatalog> | null = null;
  return (context) => {
    if (inflight) return inflight;
    inflight = loadPricingCatalog({
      homeDirectory: options.homeDirectory,
      fetch: options.fetch,
      signal: context.signal,
      now: context.now
    }).finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

export async function loadPricingCatalog(options: {
  homeDirectory: string;
  fetch?: FetchImplementation;
  signal: AbortSignal;
  now: Date;
}): Promise<PricingCatalog> {
  const cachePath = modelsDevCachePath(options.homeDirectory);
  if (memory?.cachePath === cachePath) {
    const age = options.now.valueOf() - Date.parse(memory.fetchedAt);
    if (Number.isFinite(age) && age < CACHE_TTL_MS) return memory.catalog;
  }
  const cached = await readCache(cachePath);
  const cacheAge = cached ? options.now.valueOf() - Date.parse(cached.fetchedAt) : Number.POSITIVE_INFINITY;
  if (cached && Number.isFinite(cacheAge) && cacheAge < CACHE_TTL_MS) {
    const catalog = parseModelsDevCatalog(cached.catalog, `models-dev:${cached.fetchedAt}`);
    memory = { cachePath, fetchedAt: cached.fetchedAt, catalog };
    return catalog;
  }

  try {
    const payload = await fetchModelsDev(options.fetch ?? fetch, options.signal);
    const fetchedAt = options.now.toISOString();
    await writeCache(cachePath, { fetchedAt, catalog: payload });
    const catalog = parseModelsDevCatalog(payload, `models-dev:${fetchedAt}`);
    memory = { cachePath, fetchedAt, catalog };
    return catalog;
  } catch {
    if (cached) {
      const catalog = parseModelsDevCatalog(cached.catalog, `models-dev:${cached.fetchedAt}`);
      memory = { cachePath, fetchedAt: cached.fetchedAt, catalog };
      return catalog;
    }
    return emptyPricingCatalog();
  }
}

export function modelsDevCachePath(homeDirectory: string): string {
  return path.join(homeDirectory, ".usageatlas", "model-pricing", "models-dev-v1.json");
}

async function fetchModelsDev(fetchImplementation: FetchImplementation, signal: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeout]);
  const response = await fetchImplementation(MODELS_DEV_URL, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: combined
  });
  if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_BYTES) {
    throw new Error("models.dev response is too large.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAXIMUM_BYTES) throw new Error("models.dev response is too large.");
  return JSON.parse(text) as unknown;
}

async function readCache(file: string): Promise<CacheFile | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    const root = record(parsed);
    const fetchedAt = typeof root?.fetchedAt === "string" ? root.fetchedAt : null;
    if (!root || !fetchedAt || !Number.isFinite(Date.parse(fetchedAt))) return null;
    return { fetchedAt, catalog: root.catalog };
  } catch {
    return null;
  }
}

async function writeCache(file: string, value: CacheFile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

function parseModelRate(value: unknown): ModelRate | null {
  const cost = record(value);
  if (!cost) return null;
  const input = perToken(cost.input);
  const output = perToken(cost.output);
  if (input === null || output === null) return null;
  const longContext = parseLongContext(cost);
  return {
    input,
    output,
    cacheRead: perToken(cost.cache_read) ?? undefined,
    cacheWrite: perToken(cost.cache_write) ?? undefined,
    ...longContext
  };
}

function parseLongContext(cost: Record<string, unknown>): Partial<ModelRate> {
  const tiers = Array.isArray(cost.tiers) ? cost.tiers : [];
  for (const entry of tiers) {
    const tier = record(entry);
    const meta = record(tier?.tier);
    const size = typeof meta?.size === "number" ? meta.size : null;
    if (!tier || meta?.type !== "context" || size === null || !Number.isFinite(size) || size <= 0) continue;
    return {
      threshold: size,
      inputAboveThreshold: perToken(tier.input) ?? undefined,
      outputAboveThreshold: perToken(tier.output) ?? undefined,
      cacheReadAboveThreshold: perToken(tier.cache_read) ?? undefined,
      cacheWriteAboveThreshold: perToken(tier.cache_write) ?? undefined
    };
  }
  const over = record(cost.context_over_200k);
  if (!over) return {};
  return {
    threshold: 200_000,
    inputAboveThreshold: perToken(over.input) ?? undefined,
    outputAboveThreshold: perToken(over.output) ?? undefined,
    cacheReadAboveThreshold: perToken(over.cache_read) ?? undefined,
    cacheWriteAboveThreshold: perToken(over.cache_write) ?? undefined
  };
}

function perToken(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value / 1_000_000;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
