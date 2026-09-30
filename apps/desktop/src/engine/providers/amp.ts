import { bearer, date, metric, number, quotaAdapter, quotaJson, reading, record, type QuotaOptions, type QuotaReading } from "./quota-shared";
import { ProviderError } from "../provider";
import { invalidResponse } from "./shared";
export function createAmpAdapter(options: QuotaOptions = {}) {
  return quotaAdapter("amp", async (credential, context, opts) => {
    const payload = record(await quotaJson("Amp", "https://ampcode.com/api/internal?userDisplayBalanceInfo", context, opts, {
      method: "POST", headers: { ...bearer(credential), "Content-Type": "application/json" },
      body: JSON.stringify({ method: "userDisplayBalanceInfo", params: {} })
    }));
    if (payload.ok !== true) {
      if (["UNAUTHORIZED", "FORBIDDEN", "auth-required"].includes(String(record(payload.error).code))) throw new ProviderError("auth_required", "Amp rejected this access token. Update Settings → Sources.");
      throw invalidResponse("Amp");
    }
    return parseAmpUsage(record(payload.result).displayText, context.now);
  }, options);
}
export function parseAmpUsage(value: unknown, now: Date): QuotaReading {
  if (typeof value !== "string" || value.length > 65_536) throw invalidResponse("Amp");
  // Only accept known usage lines, never identity text or arbitrary monetary numbers.
  // eslint-disable-next-line no-control-regex -- CLI display text can contain ANSI escape sequences.
  const text = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "").replaceAll("**", "");
  const amount = "([0-9][0-9,]*(?:\\.[0-9]+)?)";
  const n = (s: string | undefined) => number(s?.replaceAll(",", ""));
  const metrics = []; let plan: string | null = null;
  const money = new RegExp(`^\\s*Amp Free:\\s*\\$${amount}\\s*/\\s*\\$${amount}\\s+remaining`, "imu").exec(text);
  if (money && n(money[1]) !== null && n(money[2]) !== null && n(money[1])! <= n(money[2])!)
    metrics.push(metric("free", "Amp Free", "USD", null, n(money[2]), n(money[1])));
  else {
    const free = new RegExp(`^\\s*Amp Free:\\s*${amount}%\\s+remaining(?:\\s+today)?(.*)$`, "imu").exec(text);
    if (free && n(free[1]) !== null && n(free[1])! <= 100)
      metrics.push(metric("free", "Amp Free", "percent", 100 - n(free[1])!, 100, n(free[1]), /resets daily/iu.test(free[2]) ? dailyReset(now) : null));
  }
  const tier = new RegExp(`^\\s*Amp ([^\\r\\n]+?) Tier:\\s*agent usage \\$${amount} of \\$${amount} remaining([^\\r\\n]*)`, "imu").exec(text);
  if (tier) {
    plan = tier[1];
    const period = /period (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/u.exec(tier[4]);
    const reset = period && date(period[1]) && date(period[2]) && period[2] > period[1] ? date(period[2]) : null;
    if (n(tier[2]) !== null && n(tier[3]) !== null && n(tier[2])! <= n(tier[3])!)
      metrics.push(metric("agent", "Agent allowance", "USD", null, n(tier[3]), n(tier[2]), reset));
    const orb = new RegExp(`orb usage ${amount}h of ${amount}h a1\\.small orb hours remaining`, "iu").exec(tier[4]);
    if (orb && n(orb[1]) !== null && n(orb[2]) !== null && n(orb[1])! <= n(orb[2])!)
      metrics.push(metric("orb", "Orb allowance", "hours", null, n(orb[2]), n(orb[1]), reset));
  } else {
    const subscription = new RegExp(`^\\s*(?:Subscription ([^:\\r\\n]+)|Amp ([^:\\r\\n]+) Subscription):\\s*${amount}% other usage and ${amount}% orb usage remaining`, "imu").exec(text);
    if (subscription) {
      plan = subscription[1] ?? subscription[2];
      if (n(subscription[3]) !== null && n(subscription[3])! <= 100) metrics.push(metric("agent", "Agent allowance", "percent", 100 - n(subscription[3])!, 100));
      if (n(subscription[4]) !== null && n(subscription[4])! <= 100) metrics.push(metric("orb", "Orb allowance", "percent", 100 - n(subscription[4])!, 100));
      // Rounded "in N days/months" is not an exact reset timestamp.
    }
  }
  const personal = new RegExp(`^\\s*Individual credits:\\s*\\$${amount} remaining`, "imu").exec(text);
  if (personal) metrics.push(metric("balance", "Individual credits", "USD", null, null, n(personal[1])));
  const workspace = new RegExp(`^\\s*Workspace [^:\\r\\n]+:\\s*\\$${amount} remaining`, "gimu");
  let index = 0;
  for (const match of text.matchAll(workspace)) {
    if (++index > 12) throw invalidResponse("Amp");
    metrics.push(metric(`workspace_${index}`, `Workspace ${index} credits`, "USD", null, null, n(match[1])));
  }
  return reading("Amp", metrics, plan);
}
function dailyReset(now: Date): string | null {
  const format = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" });
  const hour = 3600_000;
  for (let t = Math.floor(now.valueOf() / hour) * hour + hour; t <= now.valueOf() + 26 * hour; t += hour)
    if (format.format(new Date(t)) === "20") return new Date(t).toISOString();
  return null;
}
