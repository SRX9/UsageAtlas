import type {
  StoredTotals,
  UsageProvider,
  UsageRecord
} from "@usageatlas/contracts/usage";
import { PUBLIC_MODELS } from "@usageatlas/contracts/usage";
import type { UsageFact } from "@usageatlas/contracts/statistics";

/**
 * Reporting plans decide what a source the server does not model is reported as.
 *
 * A plan lists several official targets with weights, so one source can arrive on
 * the server as a mix — 30 % Codex, 20 % ChatGPT, 50 % Claude, say — instead of a
 * single relabelled provider. Which target a given request takes is drawn like a
 * wheel: see `spinTarget` in the engine, which hashes the request so a retry
 * repeats the same pick. Locally nothing is rewritten; only the uploaded copy is.
 */
export interface ReportTarget {
  /** Official provider the server should attribute this share to. */
  reportAs: OfficialProvider;
  /** Model key the server should see for that share. */
  model: string;
  /** Share of the source's usage, relative to the plan's other targets. */
  weight: number;
}

export interface ReportPlan {
  /** Local provider whose usage is rewritten. */
  source: UsageProvider;
  targets: ReportTarget[];
}

export const OFFICIAL_PROVIDERS = [
  "codex",
  "claude",
  "cursor",
  "opencode",
  "antigravity",
  "pi",
  "muse",
  "warp",
  "kimi",
  "kilo",
  "copilot",
  "factory",
  "amp",
  "qoder"
] as const satisfies readonly UsageProvider[];

export type OfficialProvider = (typeof OFFICIAL_PROVIDERS)[number];

const ALL_PROVIDERS = new Set<string>([
  ...OFFICIAL_PROVIDERS,
  "freebuff",
  "zai",
  "gemini",
  "qwen",
  "cline",
  "roo"
]);

/** Every source this build can collect, including the ones the server does not model. */
export const KNOWN_PROVIDERS = [...ALL_PROVIDERS] as const;

export const MAX_PLAN_TARGETS = 12;
const MAX_MODEL_LENGTH = 80;
const MAX_WEIGHT = 1_000;

export function isOfficialProvider(value: unknown): value is OfficialProvider {
  return typeof value === "string" && (OFFICIAL_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Keeps one plan per source, drops unknown providers and blank models, and keeps
 * the first entry for a repeated provider/model pair.
 */
export function validateReportPlans(value: unknown): ReportPlan[] {
  if (!Array.isArray(value)) return [];
  const seenSources = new Set<string>();
  const plans: ReportPlan[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const source = record.source;
    if (typeof source !== "string" || !ALL_PROVIDERS.has(source) || seenSources.has(source)) continue;
    const targets = validateTargets(record.targets);
    if (!targets.length) continue;
    seenSources.add(source);
    plans.push({ source: source as UsageProvider, targets });
  }
  return plans;
}

function validateTargets(value: unknown): ReportTarget[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const targets: ReportTarget[] = [];
  for (const item of value.slice(0, MAX_PLAN_TARGETS)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const reportAs = record.reportAs;
    const model = typeof record.model === "string" ? record.model.trim() : "";
    const weight = record.weight;
    if (!isOfficialProvider(reportAs) || !model || model.length > MAX_MODEL_LENGTH) continue;
    if (!/^[A-Za-z0-9._:/-]+$/u.test(model)) continue;
    if (typeof weight !== "number" || !Number.isInteger(weight) || weight < 1 || weight > MAX_WEIGHT) continue;
    const key = `${reportAs}\u0000${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ reportAs, model, weight });
  }
  return targets;
}

/** The plan that rewrites this source, if the user saved one. */
export function planFor(plans: readonly ReportPlan[], provider: string): ReportPlan | null {
  return plans.find(plan => plan.source === provider) ?? null;
}

/** Sum of a plan's weights; a plan without targets weighs nothing. */
export function planWeight(plan: ReportPlan): number {
  return plan.targets.reduce((total, target) => total + target.weight, 0);
}

/** One target's share, as a fraction of the plan. */
export function targetShare(plan: ReportPlan, target: ReportTarget): number {
  const total = planWeight(plan);
  return total > 0 ? target.weight / total : 0;
}

/** Rewrites one statistics fact for upload; the caller renumbers the result. */
export function applyTargetToFact(fact: UsageFact, target: ReportTarget): UsageFact {
  if (fact.kind !== "usage_event") return { ...fact, providerId: target.reportAs };
  return {
    ...fact,
    providerId: target.reportAs,
    modelKey: target.model,
    reportedModel: target.model
  };
}

/**
 * Rewrites one history record for upload. Daily model breakdowns collapse onto the
 * declared model so the server does not receive an unknown model key; the local
 * record keeps its real provider and its real breakdown.
 */
export function applyTargetToRecord(record: UsageRecord, target: ReportTarget): UsageRecord {
  if (record.kind !== "usage_day" || !record.models || record.models.length === 0) {
    return { ...record, providerId: target.reportAs };
  }
  // The uploaded copy is the day this computer already holds: same totals, same
  // hours, same model rows. Only a private model name has to be reported under
  // the plan's public one, because the server validates every model key against
  // its catalog and refuses the whole day for one unknown name. Collapsing a
  // day whose models are all public threw away a breakdown the server stores.
  if (record.models.every(model => isPublicModel(model.modelKey))) {
    return { ...record, providerId: target.reportAs };
  }
  return {
    ...record,
    providerId: target.reportAs,
    models: [{ modelKey: target.model, totals: sumTotals(record.models.map(row => row.totals)) }]
  };
}

/**
 * Puts a cloud copy back on the local provider it came from, so a relabelled upload
 * never renames the row counted on this computer.
 */
export function unaliasUsageRecord(record: UsageRecord, local: UsageRecord): UsageRecord {
  if (record.providerId === local.providerId) return record;
  // The local breakdown only belongs on a cloud copy that counts the same usage.
  // Borrowing it from a different snapshot would make the copy contradict itself
  // (its models would exceed its daily totals) and no reader could accept it again.
  if (record.kind === "usage_day" && local.kind === "usage_day" && sameTotals(record.totals, local.totals))
    return { ...record, providerId: local.providerId, models: local.models };
  return { ...record, providerId: local.providerId };
}

function sameTotals(a: StoredTotals | null, b: StoredTotals | null): boolean {
  if (a === null || b === null) return a === b;
  return (Object.keys(a) as (keyof StoredTotals)[]).every(key => a[key] === b[key]);
}

/** Reads the single-target rules older versions stored, as one-target plans. */
export function planFromLegacyAliases(value: unknown): ReportPlan[] {
  if (!Array.isArray(value)) return [];
  return validateReportPlans(value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    return { source: record.source, targets: [{ reportAs: record.reportAs, model: record.model, weight: 100 }] };
  }).filter(Boolean));
}

function isPublicModel(modelKey: string): boolean {
  return PUBLIC_MODELS.has(modelKey);
}

function sumTotals(rows: StoredTotals[]): StoredTotals {
  const priced = rows.filter(row => row.estimatedCostMicrosUSD !== null);
  return {
    inputTokens: sum(rows, row => row.inputTokens),
    cachedInputTokens: sum(rows, row => row.cachedInputTokens),
    cacheCreationInputTokens: sum(rows, row => row.cacheCreationInputTokens),
    outputTokens: sum(rows, row => row.outputTokens),
    totalTokens: sum(rows, row => row.totalTokens),
    requests: sum(rows, row => row.requests),
    estimatedCostMicrosUSD: priced.length === 0 ? null : sum(priced, row => row.estimatedCostMicrosUSD ?? 0),
    unpricedTokens: sum(rows, row => row.unpricedTokens)
  };
}

function sum(rows: StoredTotals[], pick: (row: StoredTotals) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}
