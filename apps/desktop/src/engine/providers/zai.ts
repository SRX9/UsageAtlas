import type { QuotaMetric } from "@usageatlas/contracts";
import { ProviderError } from "../provider";
import { bearer, metric, number, quotaAdapter, quotaJson, reading, record, type QuotaOptions, type QuotaReading } from "./quota-shared";
import { invalidResponse } from "./shared";

/** Global keys use api.z.ai; China (BigModel) keys use open.bigmodel.cn. */
const HOSTS = { global: "https://api.z.ai", china: "https://open.bigmodel.cn" } as const;

export function createZaiAdapter(options: QuotaOptions = {}) {
  return quotaAdapter("zai", async (credential, context, opts) => {
    const host = credential.region === "china" ? HOSTS.china : HOSTS.global;
    const payload = record(await quotaJson("z.ai", `${host}/api/monitor/usage/quota/limit`, context, opts, {
      headers: bearer(credential)
    }));
    return parseZaiUsage(payload);
  }, options);
}

/**
 * z.ai returns HTTP 200 for rejected credentials, so the envelope decides.
 * Limits are reported as `usage` (the allowance) plus `currentValue` (used),
 * with `nextResetTime` in milliseconds. Only COding Plan token/credit windows
 * are mapped; MCP time limits and unknown shapes are withheld.
 */
export function parseZaiUsage(value: unknown): QuotaReading {
  const root = record(value);
  const code = number(root.code);
  if (root.success !== true && code !== 200) {
    if (code === 401 || code === 403 || code === 1000 || code === 1001 || code === 1002 || code === 1003)
      throw new ProviderError("auth_required", "z.ai rejected this API key. Update it in Settings → Sources.");
    throw invalidResponse("z.ai");
  }
  const data = record(root.data);
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const metrics: Array<QuotaMetric | null> = [];
  for (const item of limits.slice(0, 16)) {
    const limit = record(item);
    const window = zaiWindow(limit.unit, limit.number);
    if (!window) continue;
    const type = String(limit.type ?? "");
    if (type !== "TOKENS_LIMIT" && type !== "CREDIT_LIMIT") continue;
    const unit = type === "TOKENS_LIMIT" ? "tokens" : "credits";
    const used = number(limit.currentValue) ?? number(limit.used);
    const allowance = number(limit.usage) ?? number(limit.limit);
    if (used === null && allowance === null) {
      const percent = number(limit.percentage);
      if (percent === null || percent > 100) continue;
      metrics.push(metric(window.id, window.label, "percent", percent, 100, null, limit.nextResetTime));
      continue;
    }
    metrics.push(metric(window.id, window.label, unit, used, allowance, limit.remaining, limit.nextResetTime));
  }
  const plan = firstString(data.level, data.planName, data.plan, data.plan_type, data.packageName);
  return reading("z.ai", metrics, plan);
}

function zaiWindow(unit: unknown, count: unknown): { id: string; label: string } | null {
  const u = number(unit);
  const n = number(count);
  // z.ai encodes the rolling Coding Plan windows as hours (#3) and days (#6).
  if (u === 3 && n === 5) return { id: "session", label: "5 hours" };
  if (u === 6 && n === 1) return { id: "weekly", label: "7 days" };
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
