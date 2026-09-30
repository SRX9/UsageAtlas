import type { QuotaMetric } from "@usageatlas/contracts";
import { bearer, date, metric, number, quotaAdapter, quotaJson, reading, record, type QuotaOptions, type QuotaReading } from "./quota-shared";

export function createKimiAdapter(options: QuotaOptions = {}) {
  return quotaAdapter("kimi", async (credential, context, opts) => {
    const host = credential.region === "global" ? "api.kimi.ai" : "api.kimi.com";
    return parseKimiUsage(await quotaJson("Kimi Code", `https://${host}/coding/v1/usages`, context, opts, { headers: bearer(credential) }));
  }, options);
}
export function parseKimiUsage(value: unknown): QuotaReading {
  const root = record(value); const pools = record(root.usages);
  const counters = (id: string, label: string, v: unknown): QuotaMetric | null => {
    const d = record(v);
    if (number(d.limit) === null || (number(d.used) === null && number(d.remaining) === null)) return null;
    return metric(id, label, "requests", d.used, d.limit, d.remaining, d.resetTime ?? d.resetAt ?? d.reset_time ?? d.reset_at);
  };
  const weekly = counters("weekly", "7 days", root.usage);
  const limits = Array.isArray(root.limits) ? root.limits : [];
  const legacy = limits.slice(0, 12).flatMap((value) => {
    const item = record(value); const w = record(item.window);
    const duration = number(w.duration);
    const multiplier = ({ TIME_UNIT_MINUTE: 1, TIME_UNIT_HOUR: 60, TIME_UNIT_DAY: 1440 } as Record<string, number>)[String(w.timeUnit)];
    const minutes = duration !== null && multiplier ? duration * multiplier : 0;
    if (!minutes || minutes > 525600) return [];
    const m = counters(minutes === 300 ? "session" : `limit_${minutes}`, `${minutes % 60 ? minutes : minutes / 60} ${minutes % 60 ? "minutes" : "hours"}`, item.detail);
    return m ? [m] : [];
  });
  function pool(key: string, id: string, label: string, fallback: QuotaMetric | null): QuotaMetric | null {
    const p = record(pools[key]); const ratio = number(p.used_ratio); const reset = date(p.reset_time);
    if (ratio === null) return fallback;
    // Observed mixed responses include zero placeholders whose reset differs by <2 seconds.
    const placeholder = ratio === 0 && pools.limit_month_total == null && weekly && fallback?.used &&
      fallback.resetAt && reset && Math.abs(Date.parse(fallback.resetAt) - Date.parse(reset)) <= 2000;
    return placeholder ? fallback : metric(id, label, "percent", ratio * 100, 100, null, reset);
  }
  const metrics = [pool("limit_5h", "session", "5 hours", legacy.find(m => m.id === "session") ?? null),
    pool("limit_7d", "weekly", "7 days", weekly), pool("limit_month_total", "plan", "Monthly shared allowance", null),
    ...legacy.filter(m => m.id !== "session")];
  const level = record(record(root.user).membership).level;
  return reading("Kimi Code", metrics, typeof level === "string" && level !== "LEVEL_UNSPECIFIED" ? level : null);
}
