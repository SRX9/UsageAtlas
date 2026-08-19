import { randomUUID } from "node:crypto";
import type { HistoryDayPayload, HistoryDayRecord } from "@usageatlas/contracts";
import { dayRange } from "./days";
import { canReplaceSealed, isEmptyHistoryPayload } from "./payload";
import type { HistoryStore } from "./types";

export class MemoryHistoryStore implements HistoryStore {
  private readonly rows = new Map<string, HistoryDayRecord>();
  private readonly replica: string;
  private nextSeq = 1;

  constructor(replicaId: string = randomUUID()) {
    this.replica = replicaId;
  }

  replicaId(): string {
    return this.replica;
  }

  get(providerId: string, accountKey: string, localDay: string): HistoryDayRecord | null {
    return this.rows.get(rowKey(providerId, accountKey, localDay)) ?? null;
  }

  getRange(providerId: string, startDay: string, endDay: string): HistoryDayRecord[] {
    return [...this.rows.values()]
      .filter((row) => row.providerId === providerId
        && row.localDay >= startDay
        && row.localDay <= endDay)
      .sort((left, right) => left.localDay.localeCompare(right.localDay)
        || left.accountKey.localeCompare(right.accountKey));
  }

  missingDays(providerId: string, accountKey: string, startDay: string, endDay: string): string[] {
    return dayRange(startDay, endDay).filter((day) => {
      const row = this.get(providerId, accountKey, day);
      return row === null || !row.sealed;
    });
  }

  upsertDraft(
    providerId: string,
    accountKey: string,
    localDay: string,
    payload: HistoryDayPayload
  ): HistoryDayRecord {
    const key = rowKey(providerId, accountKey, localDay);
    const existing = this.rows.get(key);
    if (existing?.sealed) return existing;
    const record = this.write(existing, providerId, accountKey, localDay, payload, false);
    this.rows.set(key, record);
    return record;
  }

  sealDay(
    providerId: string,
    accountKey: string,
    localDay: string,
    payload: HistoryDayPayload
  ): HistoryDayRecord | null {
    if (isEmptyHistoryPayload(payload)) {
      const existing = this.get(providerId, accountKey, localDay);
      return existing?.sealed ? existing : null;
    }
    const key = rowKey(providerId, accountKey, localDay);
    const existing = this.rows.get(key);
    if (existing?.sealed && !canReplaceSealed(existing.payload, payload)) return existing;
    const record = this.write(existing, providerId, accountKey, localDay, payload, true);
    this.rows.set(key, record);
    return record;
  }

  sealDraftsBefore(providerId: string, today: string): HistoryDayRecord[] {
    const sealed: HistoryDayRecord[] = [];
    for (const row of this.rows.values()) {
      if (row.providerId !== providerId || row.sealed || row.localDay >= today) continue;
      if (isEmptyHistoryPayload(row.payload)) continue;
      const next = this.sealDay(row.providerId, row.accountKey, row.localDay, row.payload);
      if (next) sealed.push(next);
    }
    return sealed;
  }

  changesSince(changeSeq: number): HistoryDayRecord[] {
    return [...this.rows.values()]
      .filter((row) => row.changeSeq > changeSeq)
      .sort((left, right) => left.changeSeq - right.changeSeq);
  }

  applyRemote(records: HistoryDayRecord[]): void {
    for (const remote of records) {
      const key = rowKey(remote.providerId, remote.accountKey, remote.localDay);
      const existing = this.rows.get(key);
      if (!existing) {
        this.rows.set(key, { ...remote, changeSeq: this.nextSeq++ });
        continue;
      }
      if (existing.sealed) continue;
      if (remote.sealed) {
        this.rows.set(key, {
          ...remote,
          id: existing.id,
          changeSeq: this.nextSeq++
        });
      }
    }
  }

  private write(
    existing: HistoryDayRecord | undefined,
    providerId: string,
    accountKey: string,
    localDay: string,
    payload: HistoryDayPayload,
    sealed: boolean
  ): HistoryDayRecord {
    return {
      id: existing?.id ?? randomUUID(),
      providerId,
      accountKey,
      localDay,
      sealed,
      changeSeq: this.nextSeq++,
      updatedAt: new Date().toISOString(),
      payload: { ...payload, accountKey }
    };
  }
}

function rowKey(providerId: string, accountKey: string, localDay: string): string {
  return `${providerId}\0${accountKey}\0${localDay}`;
}
