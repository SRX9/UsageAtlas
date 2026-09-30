import { bearer, date, metric, number, quotaAdapter, quotaJson, reading, record, type QuotaOptions, type QuotaReading } from "./quota-shared";
import { ProviderError } from "../provider";
import { invalidResponse } from "./shared";
export function createFactoryAdapter(options: QuotaOptions = {}) {
  return quotaAdapter("factory", async (credential, context, opts) => {
    const headers = { ...bearer(credential), "Content-Type": "application/json", Origin: "https://app.factory.ai", Referer: "https://app.factory.ai/", "x-factory-client": "web-app" };
    let limits: unknown;
    try { limits = await quotaJson("Factory / Droid", "https://api.factory.ai/api/billing/limits", context, opts, { headers }); }
    catch (error) { if (!(error instanceof ProviderError) || error.code !== "http_404") throw error; }
    if (record(limits).usesTokenRateLimitsBilling === true) return parseFactoryLimits(limits, context.now);
    if (limits !== undefined && record(limits).usesTokenRateLimitsBilling !== false) throw invalidResponse("Factory / Droid");
    const auth = record(await quotaJson("Factory / Droid", "https://api.factory.ai/api/app/auth/me", context, opts, { headers }));
    const user = record(auth.userProfile).id;
    const url = new URL("https://api.factory.ai/api/organization/subscription/usage");
    url.searchParams.set("useCache", "true");
    if (typeof user === "string" && user) url.searchParams.set("userId", user);
    return parseFactoryLegacy(await quotaJson("Factory / Droid", url.href, context, opts, { headers }));
  }, options);
}
export function parseFactoryLimits(value: unknown, now: Date): QuotaReading {
  const root = record(value); const limits = record(root.limits); const metrics = [];
  for (const pool of ["standard", "core"]) {
    for (const [key, kind, label] of [["fiveHour", "session", "5 hours"], ["weekly", "weekly", "7 days"], ["monthly", "plan", "Monthly"]]) {
      const w = record(record(limits[pool])[key]); let used = number(w.usedPercent);
      if (used === null) continue;
      const seconds = number(w.secondsRemaining); const end = date(typeof w.windowEnd === "string" && /^\d+$/u.test(w.windowEnd) ? Number(w.windowEnd) : w.windowEnd);
      const reset = seconds !== null && seconds > 0 && seconds < 366 * 86400 ? new Date(now.valueOf() + seconds * 1000).toISOString()
        : end && Date.parse(end) > now.valueOf() ? end : null;
      // Match Factory's documented expired-window behavior only when an actual end was returned.
      if (!reset && end && w.secondsRemaining == null) used = 0;
      metrics.push(metric(pool === "core" ? `core_${kind}` : kind, pool === "core" ? `Core ${label}` : label, "percent", used, 100, null, reset));
    }
  }
  const balance = number(root.extraUsageBalanceCents);
  if (balance !== null) metrics.push(metric("extra_balance", "Extra usage balance", "USD", null, null, balance / 100));
  return reading("Factory / Droid", metrics);
}
export function parseFactoryLegacy(value: unknown): QuotaReading {
  const usage = record(record(value).usage); const metrics = [];
  for (const pool of ["standard", "premium"]) {
    const p = record(usage[pool]); const ratio = number(p.usedRatio);
    const used = number(p.orgTotalTokensUsed); const allowance = number(p.totalAllowance);
    // Upstream treats allowances above one trillion as unlimited sentinels.
    const limit = allowance !== null && allowance <= 1e12 ? allowance : null;
    const zeroPlaceholder = ratio === 0 && used !== null && used > 0 && limit !== null && limit > 0;
    // Out-of-range usedRatio values have an ambiguous scale. Prefer explicit counts in that case.
    if (ratio !== null && ratio <= 1.001 && !zeroPlaceholder)
      metrics.push(metric(pool, `${pool === "standard" ? "Standard" : "Premium"} allowance`, "percent", ratio * 100, 100, null, usage.endDate));
    else if (used !== null)
      metrics.push(metric(pool, `${pool === "standard" ? "Standard" : "Premium"} organization tokens`, "tokens", used, limit, null, usage.endDate));
    if (number(p.userTokens) !== null) metrics.push(metric(`${pool}_user`, `${pool === "standard" ? "Standard" : "Premium"} user tokens`, "tokens", p.userTokens, null, null, usage.endDate));
  }
  return reading("Factory / Droid", metrics);
}
