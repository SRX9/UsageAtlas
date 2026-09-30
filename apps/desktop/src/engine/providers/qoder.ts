import { metric, number, quotaAdapter, quotaJson, reading, record, type QuotaOptions, type QuotaReading } from "./quota-shared";
import { invalidResponse } from "./shared";
export function createQoderAdapter(options: QuotaOptions = {}) {
  return quotaAdapter("qoder", async (credential, context, opts) => {
    const origin = credential.region === "china" ? "https://qoder.com.cn" : "https://qoder.com";
    return parseQoderUsage(await quotaJson("Qoder", `${origin}/api/v2/me/usages/big_model_credits`, context, opts, { headers: {
      Cookie: credential.secret, Accept: "application/json, text/plain, */*", Origin: origin, Referer: `${origin}/account/usage`,
      "X-Requested-With": "XMLHttpRequest", "Bx-V": "2.5.35"
    } }));
  }, options);
}
export function parseQoderUsage(value: unknown): QuotaReading {
  const root = record(value); const metrics = [];
  const reset = root.nextResetAt ?? root.next_reset_at;
  for (const [key, snake, id, label] of [["totalQuota", "total_quota", "plan", "Personal credits"], ["sharedQuota", "shared_quota", "shared", "Shared credits"]]) {
    const container = root[key] ?? root[snake];
    if (container == null && id === "shared") continue;
    const pool = record(container); const summary = record(pool.quotaSummary ?? pool.quota_summary);
    const used = number(summary.usedValue ?? summary.used_value); const limit = number(summary.limitValue ?? summary.limit_value);
    const rawRemaining = summary.remainingValue ?? summary.remaining_value;
    const remaining = number(rawRemaining);
    if (used === null || limit === null || rawRemaining != null && remaining === null || limit === 0 && (used > 0 || (remaining ?? 0) > 0)) throw invalidResponse("Qoder");
    metrics.push(metric(id, label, "credits", used, limit, remaining, reset));
  }
  return reading("Qoder", metrics);
}
