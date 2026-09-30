import { createHash } from "node:crypto";
import type { DashboardProvider, QuotaMetric } from "@usageatlas/contracts";
import type { ProviderAdapter, ProviderContext } from "../provider";
import { ProviderError } from "../provider";
import type { FetchImplementation } from "../platform/http";
import { QUOTA_PROVIDERS, type QuotaProviderId, type ProviderCredential } from "../../shared/quota-providers";
import { resolveQuotaCredential, type CredentialOptions } from "./quota-credentials";
import { invalidResponse, usageWindow } from "./shared";

export interface QuotaOptions extends CredentialOptions { fetch?: FetchImplementation }
export type QuotaReading = Pick<DashboardProvider, "windows" | "credits" | "identity" | "quotaMetrics">;
export type QuotaFetcher = (credential: ProviderCredential, context: ProviderContext, options: QuotaOptions) => Promise<QuotaReading>;

export function quotaAdapter(id: QuotaProviderId, fetcher: QuotaFetcher, options: QuotaOptions = {}): ProviderAdapter {
  let saved: ProviderCredential | null = null;
  let unavailable = false;
  const credentialForAccount = async () => {
    if (unavailable) throw new ProviderError("credentials_invalid", `The saved ${QUOTA_PROVIDERS[id].name} connection could not be opened. Unlock your keyring or save a new credential in Settings → Sources.`);
    return saved ?? await resolveQuotaCredential(id, options);
  };
  // Separate accounts/scopes without persisting the secret.
  const fingerprint = (credential: ProviderCredential) => createHash("sha256")
    .update(JSON.stringify([id, credential.secret, credential.region, credential.organization])).digest("hex");
  return {
    id, name: QUOTA_PROVIDERS[id].name,
    configureCredential(value, blocked = false) { saved = value; unavailable = blocked; },
    // A broken connection must stay visible so the user can repair it.
    isAvailable: async () => credentialForAccount().then(Boolean, () => true),
    async capacityAccountKey() {
      const credential = await credentialForAccount();
      return credential ? fingerprint(credential) : null;
    },
    async refresh(context) {
      const credential = await credentialForAccount();
      if (!credential) throw new ProviderError("credentials_missing", `Connect ${QUOTA_PROVIDERS[id].name} in Settings → Sources.`);
      const reading = await fetcher(credential, context, options);
      const accountKey = fingerprint(credential);
      return { ...reading, accountKey, source: "provider_quota", analytics: null, error: null, updatedAt: context.now.toISOString() };
    }
  };
}

/** Bounded, cancellable requests; error bodies and redirect locations never reach the UI or logs. */
export async function quotaJson(name: string, url: string, context: ProviderContext, options: QuotaOptions, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]);
  try {
    response = await (options.fetch ?? fetch)(url, { ...init, redirect: "error", cache: "no-store", signal });
  } catch {
    throw new ProviderError(signal.aborted ? "timeout" : "network_error", `${name} usage could not be reached. Try again.`, true);
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new ProviderError("auth_required", `${name} rejected this credential. Update it in Settings → Sources.`);
    throw new ProviderError(`http_${response.status}`, `${name} usage returned HTTP ${response.status}.`, response.status === 429 || response.status >= 500);
  }
  const reader = response.body?.getReader();
  if (!reader) throw invalidResponse(name);
  const decoder = new TextDecoder(); let text = ""; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_048_576) { await reader.cancel(); throw invalidResponse(name); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (signal.aborted) throw new ProviderError("timeout", `${name} usage timed out.`, true);
    throw invalidResponse(name);
  } finally { reader.releaseLock(); }
}
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function number(value: unknown): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value.trim()))) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
}
export function date(value: unknown): string | null {
  const time = typeof value === "number" ? (value < 1e11 ? value * 1000 : value) : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 && time < 8.64e15 ? new Date(time).toISOString() : null;
}
export function metric(id: string, label: string, unit: QuotaMetric["unit"], used: unknown, limit: unknown, remaining: unknown = null, resetAt: unknown = null): QuotaMetric | null {
  let u = number(used); let l = number(limit); let r = number(remaining);
  if (u === null && l === null && r === null) return null;
  if (u === null && l !== null && r !== null && r <= l) u = l - r;
  if (l === null && u !== null && r !== null && u + r <= Number.MAX_SAFE_INTEGER) l = u + r;
  if (r === null && l !== null && u !== null) r = Math.max(0, l - u);
  return { id, label, unit, used: u, limit: l, remaining: r, resetAt: date(resetAt) };
}
export function reading(name: string, metrics: Array<QuotaMetric | null>, plan: string | null = null): QuotaReading {
  const quotaMetrics = metrics.filter((m): m is QuotaMetric => m !== null);
  if (!quotaMetrics.length || quotaMetrics.length > 16 || new Set(quotaMetrics.map(m => m.id)).size !== quotaMetrics.length)
    throw invalidResponse(name);
  return {
    quotaMetrics, identity: plan ? { plan: plan.slice(0, 128) } : null, credits: null,
    windows: quotaMetrics.flatMap(m => m.limit !== null && m.used !== null && (m.limit > 0 || m.used === 0)
      ? [usageWindow(m.id, m.label, m.limit > 0 ? m.used / m.limit * 100 : 100, m.resetAt)] : [])
  };
}
export function bearer(credential: ProviderCredential): Record<string, string> {
  return { Authorization: `Bearer ${credential.secret}`, Accept: "application/json" };
}
