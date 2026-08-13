import type { DashboardProvider, DashboardWindow } from "@usageatlas/contracts";

export interface LimitEntry {
  provider: DashboardProvider;
  window: DashboardWindow;
}

export const DEFAULT_LIMIT_PROVIDER_ORDER = ["codex", "claude", "cursor", "opencode"] as const;

export function limitEntries(providers: DashboardProvider[]): LimitEntry[] {
  return providers
    .flatMap((provider) => provider.enabled && !provider.error
      ? provider.windows.map((window) => ({ provider, window }))
      : [])
    .sort((left, right) => left.window.remainingPercent - right.window.remainingPercent);
}

export function rankedLimitProviders(
  providers: DashboardProvider[],
  preferredOrder: string[] = []
): DashboardProvider[] {
  const order = normalizedProviderOrder(preferredOrder, providers.map((provider) => provider.id));
  const ranks = new Map(order.map((providerID, index) => [providerID, index]));
  return [...providers].sort((left, right) => (
    (ranks.get(left.id) ?? Number.MAX_SAFE_INTEGER)
    - (ranks.get(right.id) ?? Number.MAX_SAFE_INTEGER)
  ));
}

export function previewLimitEntries(
  providers: DashboardProvider[],
  preferredOrder: string[] = [],
  maximum = 4
): LimitEntry[] {
  return rankedLimitProviders(providers, preferredOrder)
    .flatMap((provider) => {
      const entries = limitEntries([provider]);
      const preferredKind = provider.id === "cursor" ? "plan" : null;
      const entry = entries.find((candidate) => candidate.window.kind === preferredKind) ?? entries[0];
      return entry ? [entry] : [];
    })
    .slice(0, maximum);
}

export function mergeLimitProviderOrder(
  preferredOrder: string[],
  reorderedVisibleProviderIDs: string[]
): string[] {
  const order = normalizedProviderOrder(preferredOrder, reorderedVisibleProviderIDs);
  const visible = new Set(reorderedVisibleProviderIDs);
  const remaining = [...reorderedVisibleProviderIDs];
  return order.map((providerID) => visible.has(providerID) ? remaining.shift()! : providerID);
}

function normalizedProviderOrder(preferredOrder: string[], providerIDs: string[]): string[] {
  return [...new Set([
    ...(preferredOrder.length > 0 ? preferredOrder : DEFAULT_LIMIT_PROVIDER_ORDER),
    ...DEFAULT_LIMIT_PROVIDER_ORDER,
    ...providerIDs
  ])];
}
