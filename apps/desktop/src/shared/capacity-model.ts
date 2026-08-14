import type { DashboardProvider, DashboardWindow } from "@usageatlas/contracts";

export interface LimitEntry {
  provider: DashboardProvider;
  window: DashboardWindow;
}

export type TrayLimitPreferences = Record<string, boolean>;

export const DEFAULT_LIMIT_PROVIDER_ORDER = ["codex", "claude", "cursor", "opencode"] as const;

const LIMIT_KEY_PATTERN = /^[a-z0-9-]{1,64}:[a-z0-9_-]{1,64}$/u;
const MAX_STORED_LIMITS = 128;

/** Limits are ranked one by one, so a tool contributes one key per metered window. */
export function limitKey(providerID: string, windowKind: string): string {
  return `${providerID}:${windowKind}`;
}

export function limitEntryKey(entry: LimitEntry): string {
  return limitKey(entry.provider.id, entry.window.kind);
}

export function isLimitKey(value: unknown): value is string {
  return typeof value === "string" && LIMIT_KEY_PATTERN.test(value);
}

export function limitEntries(providers: DashboardProvider[]): LimitEntry[] {
  return providers.flatMap((provider) => provider.enabled && !provider.error
    ? provider.windows.map((window) => ({ provider, window }))
    : []);
}

export function rankedLimitEntries(
  providers: DashboardProvider[],
  preferredOrder: string[] = []
): LimitEntry[] {
  const entries = limitEntries(providers);
  const ranks = new Map(normalizedLimitOrder(preferredOrder, entries).map((key, index) => [key, index]));
  return [...entries].sort((left, right) => (
    (ranks.get(limitEntryKey(left)) ?? Number.MAX_SAFE_INTEGER)
    - (ranks.get(limitEntryKey(right)) ?? Number.MAX_SAFE_INTEGER)
  ));
}

export function trayLimitEntries(
  providers: DashboardProvider[],
  preferredOrder: string[] = [],
  trayLimits: TrayLimitPreferences = {}
): LimitEntry[] {
  return rankedLimitEntries(providers, preferredOrder)
    .filter((entry) => showsInTray(trayLimits, limitEntryKey(entry)));
}

/** Limits are in the tray menu until they are switched off, so new ones show up on their own. */
export function showsInTray(trayLimits: TrayLimitPreferences, key: string): boolean {
  return trayLimits[key] !== false;
}

export function mergeLimitOrder(preferredOrder: string[], reorderedVisibleKeys: string[]): string[] {
  const order = [...new Set([...preferredOrder, ...reorderedVisibleKeys])];
  const visible = new Set(reorderedVisibleKeys);
  const remaining = [...reorderedVisibleKeys];
  return order.map((key) => visible.has(key) ? remaining.shift()! : key);
}

export function sanitizeLimitOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isLimitKey))].slice(0, MAX_STORED_LIMITS);
}

export function sanitizeTrayLimits(value: unknown): TrayLimitPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, shown]) => isLimitKey(key) && typeof shown === "boolean")
      .slice(0, MAX_STORED_LIMITS)
  ) as TrayLimitPreferences;
}

function normalizedLimitOrder(preferredOrder: string[], entries: LimitEntry[]): string[] {
  return [...new Set([...preferredOrder, ...defaultLimitOrder(entries)])];
}

/**
 * Unranked limits alternate between tools instead of stacking one tool's windows
 * together, so an untouched ranking still spreads the Today preview across tools.
 */
function defaultLimitOrder(entries: LimitEntry[]): string[] {
  const keysByProvider = new Map<string, string[]>();
  for (const entry of entries) {
    const keys = keysByProvider.get(entry.provider.id) ?? [];
    keys.push(limitEntryKey(entry));
    keysByProvider.set(entry.provider.id, keys);
  }
  const providerIDs = [...keysByProvider.keys()]
    .sort((left, right) => defaultProviderRank(left) - defaultProviderRank(right));
  const depth = Math.max(0, ...providerIDs.map((providerID) => keysByProvider.get(providerID)!.length));
  const order: string[] = [];
  for (let index = 0; index < depth; index += 1) {
    for (const providerID of providerIDs) {
      const key = keysByProvider.get(providerID)![index];
      if (key) order.push(key);
    }
  }
  return order;
}

function defaultProviderRank(providerID: string): number {
  const index = DEFAULT_LIMIT_PROVIDER_ORDER.indexOf(providerID as typeof DEFAULT_LIMIT_PROVIDER_ORDER[number]);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}
