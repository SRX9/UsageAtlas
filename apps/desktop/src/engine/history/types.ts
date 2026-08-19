import type { HistoryDayPayload, HistoryDayRecord } from "@usageatlas/contracts";

export interface HistoryStore {
  replicaId(): string;
  get(providerId: string, accountKey: string, localDay: string): HistoryDayRecord | null;
  getRange(providerId: string, startDay: string, endDay: string): HistoryDayRecord[];
  /** Past calendar days in [startDay, endDay] with no sealed row for this account. */
  missingDays(providerId: string, accountKey: string, startDay: string, endDay: string): string[];
  upsertDraft(providerId: string, accountKey: string, localDay: string, payload: HistoryDayPayload): HistoryDayRecord;
  /**
   * Seal a day. Inserts when absent. Never replaces a sealed non-empty payload with empty,
   * never lets another account overwrite this account's row, and only rewrites a sealed
   * row when it was empty or a later scan improves a partial day.
   */
  sealDay(providerId: string, accountKey: string, localDay: string, payload: HistoryDayPayload): HistoryDayRecord | null;
  /** Promote every draft with local_day < today for this provider (all accounts). */
  sealDraftsBefore(providerId: string, today: string): HistoryDayRecord[];
  changesSince(changeSeq: number): HistoryDayRecord[];
  applyRemote(records: HistoryDayRecord[]): void;
  close?(): void;
}

/** Future cloud sync plugs in here without changing local store mutations. */
export interface HistorySyncAdapter {
  push(changes: HistoryDayRecord[]): Promise<void>;
  pull(cursor: string | null): Promise<{ records: HistoryDayRecord[]; cursor: string }>;
}
