import type { ReportPlan, ReportTarget } from "./report-plans";

/**
 * Picks where one unit of usage is reported.
 *
 * Weights are honoured over time, not in order: a 30/20/50 plan lands on the first
 * target for roughly three requests in ten, and can land on it several times in a
 * row, exactly like a wheel. The pick is a hash of the unit's own identity rather
 * than a random number, so the same request keeps its target when a save is
 * retried or interrupted — an observation's id is its content, and a changing
 * label would upload the same request again under a new identity.
 *
 * The hash is implemented here rather than with `node:crypto` so the Attribution
 * preview runs in the renderer and computes exactly the label the engine will
 * upload. This is used for provenance facts (scans, quotas), which carry no
 * tokens; token-bearing usage goes through `tokenTarget` instead.
 */
export function wheelTarget(plan: ReportPlan | null, key: string): ReportTarget | null {
  if (!plan || plan.targets.length === 0) return null;
  const total = plan.targets.reduce((sum, target) => sum + target.weight, 0);
  if (total <= 0) return null;
  const bucket = wheelBucket(`${plan.source}\u0000${key}\u0000${plan.targets.map(target => `${target.reportAs}:${target.model}:${target.weight}`).join("|")}`);
  let cumulative = 0;
  for (const target of plan.targets) {
    cumulative += target.weight / total;
    if (bucket < cumulative) return target;
  }
  return plan.targets[plan.targets.length - 1];
}

/**
 * Picks the target whose **token** mass is furthest behind the declared share.
 *
 * A request-count wheel says 30/20/50 but a 30-request bucket can hold 70 % of
 * the day's tokens, so the public breakdown never matched the rule. Allocating
 * tokens instead makes the long-run split equal the shares the user chose: each
 * new day or request is handed to the provider with the largest deficit.
 */
export function tokenTarget(
  plan: ReportPlan | null,
  assigned: (target: ReportTarget) => number,
  tokens: number
): ReportTarget | null {
  if (!plan || plan.targets.length === 0 || tokens <= 0) return null;
  const total = plan.targets.reduce((sum, target) => sum + target.weight, 0);
  if (total <= 0) return null;
  const allocated = plan.targets.reduce((sum, target) => sum + Math.max(0, assigned(target)), 0);
  let best: ReportTarget | null = null;
  let bestDeficit = Number.NEGATIVE_INFINITY;
  for (const target of plan.targets) {
    const expected = (allocated + tokens) * (target.weight / total);
    const deficit = expected - Math.max(0, assigned(target));
    if (deficit > bestDeficit) {
      best = target;
      bestDeficit = deficit;
    }
  }
  return best;
}

/** 32 readable bits of FNV-1a with an avalanche step, as a fraction in [0, 1). */
export function wheelBucket(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0x1_0000_0000;
}

export interface TargetPreview extends ReportTarget {
  /** Share of the source's token mass this target receives, as a fraction. */
  declared: number;
}

export interface PlanPreview {
  source: string;
  targets: TargetPreview[];
  /** Total weight, so a 3/2/5 plan reads as 100 % just like 30/20/50. */
  totalWeight: number;
}

/** The exact token split the plan will reach over time. */
export function previewPlan(plan: ReportPlan): PlanPreview {
  const totalWeight = plan.targets.reduce((sum, target) => sum + target.weight, 0);
  return {
    source: plan.source,
    totalWeight,
    targets: plan.targets.map(target => ({
      ...target,
      declared: totalWeight > 0 ? target.weight / totalWeight : 0
    }))
  };
}
