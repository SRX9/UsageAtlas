import type { DashboardSnapshot, DashboardWindow } from "@usageatlas/contracts";
import type { UsageAlertPreferences } from "../shared/desktop-api";

export interface TriggeredUsageAlert {
  providerID: string;
  providerName: string;
  windowKind: string;
  windowLabel: string;
  thresholdPercent: number;
  remainingPercent: number;
}

interface UsageObservation {
  alertedThreshold: number | null;
  resetAt: string | null;
  remainingPercent: number;
}

// Codex (and similar APIs) recompute reset timestamps from remaining percent, so
// the ISO string changes as usage ticks. Treat anything up to a 4-hour forward
// move as the same window; a real 5-hour/weekly reset jumps further and refills.
const MAX_RESET_FORWARD_MS = 4 * 60 * 60 * 1000;

export class UsageAlertEvaluator {
  private readonly observations = new Map<string, UsageObservation>();

  evaluate(
    snapshot: DashboardSnapshot,
    preferences: UsageAlertPreferences
  ): TriggeredUsageAlert[] {
    const alerts: TriggeredUsageAlert[] = [];
    for (const provider of snapshot.providers) {
      for (const window of uniqueWindowsByKind(provider.windows)) {
        const key = observationKey(provider.id, window.kind);
        const previous = this.observations.get(key);
        const resetAt = window.resetAt ?? null;
        const sameCycle = isSameUsageCycle(previous, resetAt, window.remainingPercent);
        const rule = provider.enabled ? preferences[provider.id]?.[window.kind] : undefined;
        let alertedThreshold = sameCycle ? previous?.alertedThreshold ?? null : null;

        if (!rule?.enabled || alertedThreshold !== rule.thresholdPercent) {
          alertedThreshold = null;
        }
        if (rule?.enabled && resetAt === null && window.remainingPercent > rule.thresholdPercent) {
          alertedThreshold = null;
        }

        const previousPercent = sameCycle ? previous?.remainingPercent : 100;
        const crossedThreshold = previous !== undefined
          && rule?.enabled === true
          && alertedThreshold !== rule.thresholdPercent
          && (previousPercent ?? 100) > rule.thresholdPercent
          && window.remainingPercent <= rule.thresholdPercent;

        if (crossedThreshold && rule) {
          alerts.push({
            providerID: provider.id,
            providerName: provider.name,
            windowKind: window.kind,
            windowLabel: window.label,
            thresholdPercent: rule.thresholdPercent,
            remainingPercent: window.remainingPercent
          });
          alertedThreshold = rule.thresholdPercent;
        }

        this.observations.set(key, {
          alertedThreshold,
          resetAt,
          remainingPercent: window.remainingPercent
        });
      }
    }
    return alerts;
  }
}

export function createUsageAlertNotification(alert: TriggeredUsageAlert): {
  title: string;
  body: string;
} {
  return {
    title: `${alert.providerName} capacity alert`,
    body: `${alert.windowLabel} has ${formatPercent(alert.remainingPercent)}% remaining. Your alert is set for ${alert.thresholdPercent}% remaining.`
  };
}

export const USAGE_ALERT_DELIVERY_COOLDOWN_MS = 120_000;

export function usageAlertDeliveryKey(alert: TriggeredUsageAlert): string {
  return `${alert.providerID}\u0000${alert.windowKind}\u0000${alert.thresholdPercent}`;
}

export class UsageAlertDeliveryLog {
  private readonly deliveredAt = new Map<string, number>();

  allow(alert: TriggeredUsageAlert, now = Date.now()): boolean {
    const key = usageAlertDeliveryKey(alert);
    const last = this.deliveredAt.get(key);
    if (last !== undefined && now - last < USAGE_ALERT_DELIVERY_COOLDOWN_MS) return false;
    this.deliveredAt.set(key, now);
    return true;
  }
}

function uniqueWindowsByKind(windows: DashboardWindow[]): DashboardWindow[] {
  const selected = new Map<string, DashboardWindow>();
  for (const window of windows) {
    const current = selected.get(window.kind);
    if (current === undefined || window.remainingPercent < current.remainingPercent) {
      selected.set(window.kind, window);
    }
  }
  return [...selected.values()];
}

function isSameUsageCycle(
  previous: UsageObservation | undefined,
  resetAt: string | null,
  remainingPercent: number
): boolean {
  if (previous === undefined) return false;
  if (previous.resetAt === resetAt) return true;

  const previousTime = parseResetTimestamp(previous.resetAt);
  const nextTime = parseResetTimestamp(resetAt);
  if (previousTime === null || nextTime === null) return false;

  if (nextTime - previousTime <= MAX_RESET_FORWARD_MS) return true;
  // Quota still draining: a recomputed reset time is not a new window.
  return remainingPercent <= previous.remainingPercent;
}

function parseResetTimestamp(value: string | null): number | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

function observationKey(providerID: string, windowKind: string): string {
  return `${providerID}\u0000${windowKind}`;
}
