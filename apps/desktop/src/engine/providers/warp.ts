import { release } from "node:os";
import { bearer, date, metric, number, quotaAdapter, quotaJson, reading, record, type QuotaOptions, type QuotaReading } from "./quota-shared";
import { invalidResponse } from "./shared";

const query = `query GetRequestLimitInfo($requestContext: RequestContext!) {
  user(requestContext: $requestContext) { __typename ... on UserOutput { user {
    requestLimitInfo { isUnlimited nextRefreshTime requestLimit requestsUsedSinceLastRefresh }
    bonusGrants { requestCreditsGranted requestCreditsRemaining expiration }
    workspaces { bonusGrantsInfo { grants { requestCreditsGranted requestCreditsRemaining expiration } } }
  } } }
}`;
export function createWarpAdapter(options: QuotaOptions = {}) {
  return quotaAdapter("warp", async (credential, context, opts) => {
    const category = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
    return parseWarpUsage(await quotaJson("Warp", "https://app.warp.dev/graphql/v2?op=GetRequestLimitInfo", context, opts, {
      method: "POST", headers: { ...bearer(credential), "Content-Type": "application/json", "User-Agent": "Warp/1.0",
        "x-warp-client-id": "warp-app", "x-warp-os-category": category, "x-warp-os-name": category, "x-warp-os-version": release() },
      body: JSON.stringify({ query, operationName: "GetRequestLimitInfo", variables: { requestContext: { clientContext: {}, osContext: { category, name: category, version: release() } } } })
    }), context.now);
  }, options);
}
export function parseWarpUsage(value: unknown, now: Date): QuotaReading {
  const root = record(value);
  if (root.errors && (!Array.isArray(root.errors) || root.errors.length)) throw invalidResponse("Warp");
  const user = record(record(record(root.data).user).user);
  const info = record(user.requestLimitInfo);
  if (typeof info.isUnlimited !== "boolean" || number(info.requestsUsedSinceLastRefresh) === null) throw invalidResponse("Warp");
  if (!info.isUnlimited && number(info.requestLimit) === null) throw invalidResponse("Warp");
  const metrics = [metric("plan", "Monthly credits", "credits", info.requestsUsedSinceLastRefresh,
    info.isUnlimited ? null : info.requestLimit, null, info.isUnlimited ? null : info.nextRefreshTime)];
  // Keep workspace pools separate. Their balances are not the user's personal allowance.
  function grants(value: unknown, id: string, label: string) {
    if (value == null) return;
    if (!Array.isArray(value) || value.length > 500) throw invalidResponse("Warp");
    let total = 0; let remaining = 0;
    for (const item of value) {
      const g = record(item); const expiry = date(g.expiration);
      if (expiry && Date.parse(expiry) <= now.valueOf()) continue;
      const amount = number(g.requestCreditsGranted); const balance = number(g.requestCreditsRemaining);
      if (amount === null || balance === null || balance > amount) throw invalidResponse("Warp");
      total += amount; remaining += balance;
    }
    if (total > 0) metrics.push(metric(id, label, "credits", total - remaining, total, remaining));
    // Grant expiry is not a replenishment/reset. Do not generate reset notifications for it.
  }
  grants(user.bonusGrants, "bonus", "Personal add-on credits");
  if (user.workspaces != null && !Array.isArray(user.workspaces)) throw invalidResponse("Warp");
  const workspaces = (user.workspaces ?? []) as unknown[];
  if (workspaces.length > 12) throw invalidResponse("Warp");
  workspaces.forEach((w, index) => grants(record(record(w).bonusGrantsInfo).grants, `workspace_${index + 1}`, `Workspace ${index + 1} add-on credits`));
  return reading("Warp", metrics, info.isUnlimited ? "Unlimited" : null);
}
