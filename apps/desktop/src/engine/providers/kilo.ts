import { bearer, date, metric, number, quotaAdapter, quotaJson, reading, record, type QuotaOptions, type QuotaReading } from "./quota-shared";
import { ProviderError } from "../provider";
import { invalidResponse } from "./shared";
export function createKiloAdapter(options: QuotaOptions = {}) {
  return quotaAdapter("kilo", async (credential, context, opts) => {
    const url = new URL("https://app.kilo.ai/api/trpc/user.getCreditBlocks,kiloPass.getState");
    url.searchParams.set("batch", "1"); url.searchParams.set("input", JSON.stringify({ 0: { json: null }, 1: { json: null } }));
    return parseKiloUsage(await quotaJson("Kilo Code", url.href, context, opts, { headers: {
      ...bearer(credential), ...(credential.organization ? { "X-KILOCODE-ORGANIZATIONID": credential.organization } : {})
    } }), context.now);
  }, options);
}
export function parseKiloUsage(value: unknown, now: Date): QuotaReading {
  const rows = Array.isArray(value) ? value : [record(value)["0"], record(value)["1"]];
  function payload(index: number): Record<string, unknown> {
    const row = record(rows[index]);
    if (row.error) {
      const error = record(row.error); const code = record(record(error.json).data).code ?? record(error.data).code;
      if (code === "UNAUTHORIZED" || code === "FORBIDDEN") throw new ProviderError("auth_required", "Kilo Code rejected this credential. Update Settings → Sources.");
      throw invalidResponse("Kilo Code");
    }
    const result = record(record(row.result).data);
    return record(Object.hasOwn(result, "json") ? result.json : result);
  }
  const credits = payload(0); const pass = payload(1);
  const metrics = [];
  // These fields are microdollars despite their mUsd spelling. Balance is not lifetime spend.
  if (Array.isArray(credits.creditBlocks) && credits.creditBlocks.length) {
    if (credits.creditBlocks.length > 1000) throw invalidResponse("Kilo Code");
    let total = 0; let remaining = 0; let valid = true;
    for (const item of credits.creditBlocks) {
      const block = record(item); const expires = date(block.expiry_date); const starts = date(block.effective_date);
      if (expires && Date.parse(expires) <= now.valueOf() || starts && Date.parse(starts) > now.valueOf()) continue;
      const amount = number(block.amount_mUsd); const balance = number(block.balance_mUsd);
      if (amount === null || balance === null || balance > amount) { valid = false; break; }
      total += amount / 1e6; remaining += balance / 1e6;
    }
    if (valid) metrics.push(metric("credits", "Active credit blocks", "USD", Math.max(0, total - remaining), total, remaining));
  }
  if (!metrics.length && number(credits.totalBalance_mUsd) !== null)
    metrics.push(metric("balance", "Credit balance", "USD", null, null, number(credits.totalBalance_mUsd)! / 1e6));
  if (!metrics.length && Array.isArray(credits.blocks) && credits.blocks.length) {
    // Older explicit credit counters. Do not mix records with incomplete measurements.
    let used = 0; let total = 0; let valid = true;
    for (const item of credits.blocks) {
      const b = record(item); const u = number(b.usedCredits); const t = number(b.totalCredits);
      if (u === null || t === null) { valid = false; break; }
      used += u; total += t;
    }
    if (valid) metrics.push(metric("credits", "Credits", "credits", used, total));
  }
  const s = record(pass.subscription);
  const base = number(s.currentPeriodBaseCreditsUsd); const bonus = s.currentPeriodBonusCreditsUsd == null ? 0 : number(s.currentPeriodBonusCreditsUsd);
  if (base !== null && bonus !== null && number(s.currentPeriodUsageUsd) !== null)
    metrics.push(metric("plan", "Kilo Pass", "USD", s.currentPeriodUsageUsd, base + bonus, null, s.nextBillingAt ?? s.nextRenewalAt ?? s.renewsAt));
  const plan = record(pass.plan).name;
  return reading("Kilo Code", metrics, typeof plan === "string" ? plan : Object.keys(s).length ? "Kilo Pass" : null);
}
