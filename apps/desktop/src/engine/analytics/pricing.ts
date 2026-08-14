import {
  MODELS_DEV_PROVIDER_ANTHROPIC,
  MODELS_DEV_PROVIDER_OPENAI,
  emptyPricingCatalog,
  type ModelRate,
  type PricingCatalog
} from "./models-dev";

export type { PricingCatalog } from "./models-dev";
export type Pricing = ModelRate;

export interface TokenCostInput {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation1hInputTokens?: number;
  outputTokens: number;
  occurredAt?: string;
  serviceTier?: string;
  speed?: string;
}

const CODEX_PRICING: Readonly<Record<string, Pricing>> = {
  "gpt-5": codexPrice(1.25e-6, 1e-5, 1.25e-7),
  "gpt-5-codex": codexPrice(1.25e-6, 1e-5, 1.25e-7),
  "gpt-5-mini": codexPrice(2.5e-7, 2e-6, 2.5e-8),
  "gpt-5-nano": codexPrice(5e-8, 4e-7, 5e-9),
  "gpt-5-pro": codexPrice(1.5e-5, 1.2e-4),
  "gpt-5.1": codexPrice(1.25e-6, 1e-5, 1.25e-7),
  "gpt-5.1-codex": codexPrice(1.25e-6, 1e-5, 1.25e-7),
  "gpt-5.1-codex-max": codexPrice(1.25e-6, 1e-5, 1.25e-7),
  "gpt-5.1-codex-mini": codexPrice(2.5e-7, 2e-6, 2.5e-8),
  "gpt-5.2": codexPrice(1.75e-6, 1.4e-5, 1.75e-7),
  "gpt-5.2-codex": codexPrice(1.75e-6, 1.4e-5, 1.75e-7),
  "gpt-5.2-pro": codexPrice(2.1e-5, 1.68e-4),
  "gpt-5.3-codex": codexPrice(1.75e-6, 1.4e-5, 1.75e-7),
  "gpt-5.3-codex-spark": { input: 0, output: 0, cacheRead: 0 },
  "gpt-5.4": longContextPrice(2.5e-6, 1.5e-5, 2.5e-7, 5e-6, 2.25e-5, 5e-7),
  "gpt-5.4-mini": codexPrice(7.5e-7, 4.5e-6, 7.5e-8),
  "gpt-5.4-nano": codexPrice(2e-7, 1.25e-6, 2e-8),
  "gpt-5.4-pro": longContextPrice(3e-5, 1.8e-4, 3e-5, 6e-5, 2.7e-4, 6e-5),
  "gpt-5.5": longContextPrice(5e-6, 3e-5, 5e-7, 1e-5, 4.5e-5, 1e-6),
  "gpt-5.5-pro": codexPrice(3e-5, 1.8e-4),
  "gpt-5.6-sol": longContextPrice(5e-6, 3e-5, 5e-7, 1e-5, 4.5e-5, 1e-6, 6.25e-6, 1.25e-5),
  "gpt-5.6-terra": longContextPrice(2e-6, 1.2e-5, 2e-7, 4e-6, 1.8e-5, 4e-7, 2.5e-6, 5e-6),
  "gpt-5.6-luna": longContextPrice(2e-7, 1.2e-6, 2e-8, 4e-7, 1.8e-6, 4e-8, 2.5e-7, 5e-7),
  "codex-mini-latest": codexPrice(1.5e-6, 6e-6, 3.75e-7),
  "codex-auto-review": { input: 0, output: 0, cacheRead: 0 }
};

const CLAUDE_PRICING: Readonly<Record<string, Pricing>> = {
  "claude-fable-5": claudePrice(1e-5, 5e-5, 1.25e-5, 1e-6),
  "claude-haiku-4-5": claudePrice(1e-6, 5e-6, 1.25e-6, 1e-7),
  "claude-haiku-4-5-20251001": claudePrice(1e-6, 5e-6, 1.25e-6, 1e-7),
  "claude-opus-4-5": claudePrice(5e-6, 2.5e-5, 6.25e-6, 5e-7),
  "claude-opus-4-5-20251101": claudePrice(5e-6, 2.5e-5, 6.25e-6, 5e-7),
  "claude-opus-4-6": claudePrice(5e-6, 2.5e-5, 6.25e-6, 5e-7),
  "claude-opus-4-6-20260205": claudePrice(5e-6, 2.5e-5, 6.25e-6, 5e-7),
  "claude-opus-4-7": claudePrice(5e-6, 2.5e-5, 6.25e-6, 5e-7),
  "claude-opus-4-8": claudePrice(5e-6, 2.5e-5, 6.25e-6, 5e-7),
  "claude-opus-5": claudePrice(5e-6, 2.5e-5, 6.25e-6, 5e-7),
  "claude-mythos-5": claudePrice(1e-5, 5e-5, 1.25e-5, 1e-6),
  "claude-sonnet-5": claudePrice(2e-6, 1e-5, 2.5e-6, 2e-7),
  "claude-sonnet-4-5": claudeLongContextPrice(3e-6, 1.5e-5, 3.75e-6, 3e-7),
  "claude-sonnet-4-5-20250929": claudeLongContextPrice(3e-6, 1.5e-5, 3.75e-6, 3e-7),
  "claude-sonnet-4-6": claudePrice(3e-6, 1.5e-5, 3.75e-6, 3e-7),
  "claude-opus-4-20250514": claudePrice(1.5e-5, 7.5e-5, 1.875e-5, 1.5e-6),
  "claude-opus-4-1": claudePrice(1.5e-5, 7.5e-5, 1.875e-5, 1.5e-6),
  "claude-sonnet-4-20250514": claudeLongContextPrice(3e-6, 1.5e-5, 3.75e-6, 3e-7),
  "claude-3-7-sonnet": claudePrice(3e-6, 1.5e-5, 3.75e-6, 3e-7),
  "claude-3-5-sonnet": claudePrice(3e-6, 1.5e-5, 3.75e-6, 3e-7),
  "claude-3-5-haiku": claudePrice(8e-7, 4e-6, 1e-6, 8e-8),
  "<synthetic>": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};

const CLAUDE_FAST_PRICING: Readonly<Record<string, Pricing>> = {
  "claude-opus-4-8": claudePrice(1e-5, 5e-5, 1.25e-5, 1e-6),
  "claude-opus-5": claudePrice(1e-5, 5e-5, 1.25e-5, 1e-6)
};

export function normalizeCodexModel(raw: string): string {
  let model = stripCodexIdentity(raw);
  if (model === "gpt-5.6") return "gpt-5.6-sol";
  if (CODEX_PRICING[model]) return model;
  model = model.replace(/-\d{4}-\d{2}-\d{2}$/u, "");
  return model;
}

export function normalizeClaudeModel(raw: string): string {
  const model = stripClaudeIdentity(raw);
  if (CLAUDE_PRICING[model]) return model;
  const withoutDate = model.replace(/-\d{8}$/u, "");
  return CLAUDE_PRICING[withoutDate] ? withoutDate : model;
}

export function estimateCodexCost(
  input: TokenCostInput,
  catalog: PricingCatalog | null = emptyPricingCatalog()
): number | null {
  const model = normalizeCodexModel(input.model);
  const pricing = resolveCodexPricing(input.model, catalog);
  const standardCost = estimateCodex(input, pricing);
  if (standardCost === null) return null;
  const tier = input.serviceTier?.trim().toLowerCase().replaceAll("_", "-") ?? "standard";
  if (tier !== "priority" && tier !== "fast") return standardCost;
  if (nonnegative(input.inputTokens) > 272_000) return standardCost;
  const multiplier = codexFastMultiplier(model);
  return multiplier === null ? standardCost : standardCost * multiplier;
}

export function estimateClaudeCost(
  input: TokenCostInput,
  catalog: PricingCatalog | null = emptyPricingCatalog()
): number | null {
  const speed = input.speed?.trim().toLowerCase() ?? "standard";
  const standard = resolveClaudePricing(input.model, catalog);
  if (!standard) return null;
  if (speed === "fast") {
    const model = normalizeClaudeModel(input.model);
    return estimateClaude(input, CLAUDE_FAST_PRICING[model] ?? scalePricing(standard, 2));
  }
  return estimateClaude(input, standard);
}

function resolveCodexPricing(raw: string, catalog: PricingCatalog | null): Pricing | undefined {
  const normalized = normalizeCodexModel(raw);
  const bundled = CODEX_PRICING[normalized];
  const live = firstRate(catalog, MODELS_DEV_PROVIDER_OPENAI, [
    raw.trim(),
    stripCodexIdentity(raw),
    normalized
  ]);
  return mergePricing(live, bundled);
}

function resolveClaudePricing(raw: string, catalog: PricingCatalog | null): Pricing | undefined {
  const identity = stripClaudeIdentity(raw);
  const normalized = normalizeClaudeModel(raw);
  const bundled = CLAUDE_PRICING[normalized];
  const live = firstRate(catalog, MODELS_DEV_PROVIDER_ANTHROPIC, [
    raw.trim(),
    identity,
    identity.replace(/-\d{8}$/u, ""),
    normalized
  ]);
  return mergePricing(live, bundled);
}

function firstRate(
  catalog: PricingCatalog | null,
  providerID: string,
  modelIDs: string[]
): Pricing | null {
  if (!catalog) return null;
  const seen = new Set<string>();
  for (const modelID of modelIDs) {
    if (!modelID || seen.has(modelID)) continue;
    seen.add(modelID);
    const rate = catalog.rate(providerID, modelID);
    if (rate) return rate;
  }
  return null;
}

function mergePricing(live: Pricing | null, bundled: Pricing | undefined): Pricing | undefined {
  if (!live) return bundled;
  return {
    input: live.input,
    output: live.output,
    cacheRead: live.cacheRead ?? bundled?.cacheRead,
    cacheWrite: live.cacheWrite ?? bundled?.cacheWrite,
    threshold: live.threshold ?? bundled?.threshold,
    inputAboveThreshold: live.inputAboveThreshold ?? bundled?.inputAboveThreshold,
    outputAboveThreshold: live.outputAboveThreshold ?? bundled?.outputAboveThreshold,
    cacheReadAboveThreshold: live.cacheReadAboveThreshold ?? bundled?.cacheReadAboveThreshold,
    cacheWriteAboveThreshold: live.cacheWriteAboveThreshold ?? bundled?.cacheWriteAboveThreshold
  };
}

function estimateCodex(input: TokenCostInput, pricing: Pricing | undefined): number | null {
  if (!pricing) return null;
  const rawInput = nonnegative(input.inputTokens);
  const cached = Math.min(nonnegative(input.cachedInputTokens), rawInput);
  const remainingInput = rawInput - cached;
  const cacheCreation = Math.min(nonnegative(input.cacheCreationInputTokens), remainingInput);
  const uncached = remainingInput - cacheCreation;
  const above = pricing.threshold !== undefined && rawInput > pricing.threshold;
  const inputRate = above ? pricing.inputAboveThreshold ?? pricing.input : pricing.input;
  const outputRate = above ? pricing.outputAboveThreshold ?? pricing.output : pricing.output;
  const cacheReadRate = above
    ? pricing.cacheReadAboveThreshold ?? pricing.cacheRead ?? inputRate
    : pricing.cacheRead ?? inputRate;
  const cacheWriteRate = above
    ? pricing.cacheWriteAboveThreshold ?? pricing.cacheWrite ?? inputRate
    : pricing.cacheWrite ?? inputRate;
  return uncached * inputRate
    + cached * cacheReadRate
    + cacheCreation * cacheWriteRate
    + nonnegative(input.outputTokens) * outputRate;
}

function estimateClaude(input: TokenCostInput, pricing: Pricing): number {
  const freshInput = nonnegative(input.inputTokens);
  const cached = nonnegative(input.cachedInputTokens);
  const cacheCreation = nonnegative(input.cacheCreationInputTokens);
  const cacheCreation1h = Math.min(nonnegative(input.cacheCreation1hInputTokens ?? 0), cacheCreation);
  const cacheCreation5m = cacheCreation - cacheCreation1h;
  const contextTokens = freshInput + cached + cacheCreation;
  const above = pricing.threshold !== undefined && contextTokens > pricing.threshold;
  const inputRate = above ? pricing.inputAboveThreshold ?? pricing.input : pricing.input;
  const outputRate = above ? pricing.outputAboveThreshold ?? pricing.output : pricing.output;
  const cacheReadRate = above
    ? pricing.cacheReadAboveThreshold ?? pricing.cacheRead ?? inputRate
    : pricing.cacheRead ?? inputRate;
  const cacheWrite5mRate = above
    ? pricing.cacheWriteAboveThreshold ?? pricing.cacheWrite ?? inputRate * 1.25
    : pricing.cacheWrite ?? inputRate * 1.25;
  return freshInput * inputRate
    + cached * cacheReadRate
    + cacheCreation5m * cacheWrite5mRate
    + cacheCreation1h * inputRate * 2
    + nonnegative(input.outputTokens) * outputRate;
}

function stripCodexIdentity(raw: string): string {
  return raw.trim().replace(/^openai\//u, "");
}

function stripClaudeIdentity(raw: string): string {
  let model = raw.trim();
  if (model.startsWith("anthropic.")) {
    const claudeIndex = model.lastIndexOf("claude-");
    model = claudeIndex >= 0 ? model.slice(claudeIndex) : model.slice("anthropic.".length);
  }
  return model.replace(/-v\d+:\d+$/u, "").replace(/@\d{8}$/u, "");
}

function scalePricing(pricing: Pricing, multiplier: number): Pricing {
  return {
    input: pricing.input * multiplier,
    output: pricing.output * multiplier,
    cacheRead: pricing.cacheRead === undefined ? undefined : pricing.cacheRead * multiplier,
    cacheWrite: pricing.cacheWrite === undefined ? undefined : pricing.cacheWrite * multiplier,
    threshold: pricing.threshold,
    inputAboveThreshold: pricing.inputAboveThreshold === undefined
      ? undefined
      : pricing.inputAboveThreshold * multiplier,
    outputAboveThreshold: pricing.outputAboveThreshold === undefined
      ? undefined
      : pricing.outputAboveThreshold * multiplier,
    cacheReadAboveThreshold: pricing.cacheReadAboveThreshold === undefined
      ? undefined
      : pricing.cacheReadAboveThreshold * multiplier,
    cacheWriteAboveThreshold: pricing.cacheWriteAboveThreshold === undefined
      ? undefined
      : pricing.cacheWriteAboveThreshold * multiplier
  };
}

function codexFastMultiplier(model: string): number | null {
  if (["gpt-5.4", "gpt-5.4-mini", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].includes(model)) {
    return 2;
  }
  return model === "gpt-5.5" ? 2.5 : null;
}

function nonnegative(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function codexPrice(input: number, output: number, cacheRead?: number): Pricing {
  return { input, output, cacheRead };
}

function longContextPrice(
  input: number,
  output: number,
  cacheRead: number,
  inputAboveThreshold: number,
  outputAboveThreshold: number,
  cacheReadAboveThreshold: number,
  cacheWrite?: number,
  cacheWriteAboveThreshold?: number
): Pricing {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    threshold: 272_000,
    inputAboveThreshold,
    outputAboveThreshold,
    cacheReadAboveThreshold,
    cacheWriteAboveThreshold
  };
}

function claudePrice(input: number, output: number, cacheWrite: number, cacheRead: number): Pricing {
  return { input, output, cacheWrite, cacheRead };
}

function claudeLongContextPrice(input: number, output: number, cacheWrite: number, cacheRead: number): Pricing {
  return {
    input,
    output,
    cacheWrite,
    cacheRead,
    threshold: 200_000,
    inputAboveThreshold: input * 2,
    outputAboveThreshold: output * 1.5,
    cacheWriteAboveThreshold: cacheWrite * 2,
    cacheReadAboveThreshold: cacheRead * 2
  };
}
