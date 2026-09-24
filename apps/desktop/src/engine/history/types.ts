import type { DashboardProvider, HistoryDayPayload, HistoryDayRecord } from "@usageatlas/contracts";

export interface HistoryStore {
  replicaId(): string;
  saveCollection?(providerId: string, accountKey: string, analytics: import("@usageatlas/contracts").LocalUsageAnalytics): void;
  reportingTimeZone?(providerId: string, accountKey: string): string;
  needsCollectionRefresh?(providerId: string, accountKey: string): boolean;
  needsTimezoneRefresh?(providerId: string, accountKey: string): boolean;
  get(providerId: string, accountKey: string, localDay: string): HistoryDayRecord | null;
  getRange(providerId: string, startDay: string, endDay: string): HistoryDayRecord[];
  /** Past calendar days in [startDay, endDay] with no sealed row for this account. */
  missingDays(providerId: string, accountKey: string, startDay: string, endDay: string): string[];
  upsertDraft(providerId: string, accountKey: string, localDay: string, payload: HistoryDayPayload): HistoryDayRecord;
  /**
   * Seal a day. Inserts when absent. Never replaces a sealed non-empty payload with empty,
   * never lets another account overwrite this account's row, and only rewrites a sealed
   * row for a complete scan or an improvement to partial coverage.
   */
  sealDay(providerId: string, accountKey: string, localDay: string, payload: HistoryDayPayload): HistoryDayRecord | null;
  /** Promote every draft with local_day < today for this provider (all accounts). */
  sealDraftsBefore(providerId: string, today: string): HistoryDayRecord[];
  saveCapacity?(providerId: string, accountKey: string, live: Omit<DashboardProvider, "id" | "name" | "enabled">): void;
  latestCapacity?(providerId: string): HistoryDayRecord | null;
  close?(): void | Promise<void>;
}
