import { metric, number, quotaAdapter, quotaJson, reading, record, type QuotaOptions, type QuotaReading } from "./quota-shared";
import { invalidResponse } from "./shared";
export function createCopilotAdapter(options: QuotaOptions = {}) {
  return quotaAdapter("copilot", async (credential, context, opts) => parseCopilotUsage(await quotaJson(
    "GitHub Copilot", "https://api.github.com/copilot_internal/user", context, opts, { headers: {
      Authorization: `token ${credential.secret}`, Accept: "application/json", "Editor-Version": "vscode/1.96.2",
      "Editor-Plugin-Version": "copilot-chat/0.26.7", "User-Agent": "GitHubCopilotChat/0.26.7", "X-Github-Api-Version": "2025-04-01"
    } })), options);
}
export function parseCopilotUsage(value: unknown): QuotaReading {
  const root = record(value); const snapshots = record(root.quota_snapshots);
  const reset = root.quota_reset_date; const metrics = []; let unlimited = false;
  for (const [key, label] of [["premium_interactions", "Premium requests"], ["chat", "Chat"], ["completions", "Completions"]]) {
    const q = record(snapshots[key]); const limit = number(q.entitlement); const remaining = signedNumber(q.remaining);
    if (q.unlimited === true) { unlimited = true; continue; }
    // GitHub sends 0/0 and 100%-remaining placeholders for token-billed seats.
    if (limit === 0 && remaining === 0) continue;
    if (limit !== null && limit > 0 && remaining !== null && remaining <= limit && number(limit - remaining) !== null)
      metrics.push(metric(key, label, "requests", limit - remaining, limit, Math.max(0, remaining), reset));
    else {
      const percent = signedNumber(q.percent_remaining);
      if (percent !== null && percent <= 100 && number(100 - percent) !== null)
        metrics.push(metric(key, label, "percent", 100 - percent, 100, Math.max(0, percent), reset));
    }
  }
  // Shared pool can be repeated under chat. Prefer premium, then chat, exactly once.
  const premium = record(snapshots.premium_interactions);
  const chat = record(snapshots.chat);
  const credits = number(premium.credits_used) ?? number(chat.credits_used);
  if (credits !== null && (credits > 0 || root.token_based_billing === true || premium.unlimited === true || chat.unlimited === true))
    metrics.push(metric("seat_credits", "Seat AI credits", "credits", credits, null, null, reset));
  const monthly = record(root.monthly_quotas); const left = record(root.limited_user_quotas);
  for (const key of ["chat", "completions"]) {
    if (metrics.some(m => m?.id === key) || record(snapshots[key]).unlimited === true) continue;
    const limit = number(monthly[key]); const remaining = number(left[key]);
    if (limit !== null && limit > 0 && remaining !== null && remaining <= limit)
      metrics.push(metric(key, key === "chat" ? "Chat" : "Completions", "requests", limit - remaining, limit, remaining, reset));
  }
  const plan = typeof root.copilot_plan === "string" ? root.copilot_plan : null;
  if (!metrics.length && unlimited) return { windows: [], quotaMetrics: [], credits: null, identity: { plan: plan ? `${plan} · Unlimited` : "Unlimited" } };
  if (!metrics.length) throw invalidResponse("GitHub Copilot");
  return reading("GitHub Copilot", metrics, plan);
}

/** Negative remaining counts/percentages represent overage, not invalid usage. */
function signedNumber(value: unknown): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && /^-?\d+(?:\.\d+)?$/u.test(value.trim()))) return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : null;
}
