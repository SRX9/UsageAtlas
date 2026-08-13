import type { UsageAlertPreferences, UsageAlertRule } from "./desktop-api";

export const DEFAULT_USAGE_ALERT_THRESHOLD = 20;

const MAX_PROVIDERS = 64;
const MAX_WINDOWS_PER_PROVIDER = 64;
const identifierPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export function isUsageAlertPreferences(value: unknown): value is UsageAlertPreferences {
  if (!isRecord(value)) return false;
  const providers = Object.entries(value);
  if (providers.length > MAX_PROVIDERS) return false;
  return providers.every(([providerID, windows]) => {
    if (!identifierPattern.test(providerID) || !isRecord(windows)) return false;
    const entries = Object.entries(windows);
    return entries.length <= MAX_WINDOWS_PER_PROVIDER
      && entries.every(([windowKind, rule]) => (
        identifierPattern.test(windowKind) && isUsageAlertRule(rule)
      ));
  });
}

export function sanitizeUsageAlertPreferences(value: unknown): UsageAlertPreferences {
  if (!isRecord(value)) return {};
  const result: UsageAlertPreferences = {};
  for (const [providerID, windows] of Object.entries(value).slice(0, MAX_PROVIDERS)) {
    if (!identifierPattern.test(providerID) || !isRecord(windows)) continue;
    const providerRules: Record<string, UsageAlertRule> = {};
    for (const [windowKind, rule] of Object.entries(windows).slice(0, MAX_WINDOWS_PER_PROVIDER)) {
      if (!identifierPattern.test(windowKind) || !isUsageAlertRule(rule)) continue;
      providerRules[windowKind] = {
        enabled: rule.enabled,
        thresholdPercent: rule.thresholdPercent
      };
    }
    if (Object.keys(providerRules).length > 0) result[providerID] = providerRules;
  }
  return result;
}

export function cloneUsageAlertPreferences(value: UsageAlertPreferences): UsageAlertPreferences {
  return Object.fromEntries(Object.entries(value).map(([providerID, windows]) => [
    providerID,
    Object.fromEntries(Object.entries(windows).map(([windowKind, rule]) => [
      windowKind,
      { ...rule }
    ]))
  ]));
}

function isUsageAlertRule(value: unknown): value is UsageAlertRule {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => key !== "enabled" && key !== "thresholdPercent")) {
    return false;
  }
  const thresholdPercent = value.thresholdPercent;
  return typeof value.enabled === "boolean"
    && typeof thresholdPercent === "number"
    && Number.isSafeInteger(thresholdPercent)
    && thresholdPercent >= 0
    && thresholdPercent <= 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
