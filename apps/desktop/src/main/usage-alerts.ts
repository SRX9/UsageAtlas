import type { DashboardSnapshot } from "@usageatlas/contracts";
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

export class UsageAlertEvaluator {
  private readonly observations = new Map<string, UsageObservation>();

  evaluate(
    snapshot: DashboardSnapshot,
    preferences: UsageAlertPreferences
  ): TriggeredUsageAlert[] {
    const alerts: TriggeredUsageAlert[] = [];
    for (const provider of snapshot.providers) {
      for (const window of provider.windows) {
        const key = observationKey(provider.id, window.kind);
        const previous = this.observations.get(key);
        const resetAt = window.resetAt ?? null;
        const sameCycle = previous?.resetAt === resetAt;
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

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

function observationKey(providerID: string, windowKind: string): string {
  return `${providerID}\u0000${windowKind}`;
}
