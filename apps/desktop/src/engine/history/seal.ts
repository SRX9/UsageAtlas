import {
  type DashboardProvider,
  type HistoryDayPayload,
  type LocalUsageAnalytics
} from "@usageatlas/contracts";
import { composeProviderAnalytics } from "./compose";
import { localCalendarDay, lookbackDays, shiftLocalDay } from "./days";
import { extractDayPayload, hasUsageTotals, isEmptyHistoryPayload } from "./payload";
import type { HistoryStore } from "./types";

export const HISTORY_BACKFILL_DAYS = 90;
export const HISTORY_SNAPSHOT_DAYS = 90;

export function persistProviderHistory(options: {
  timeZone?: string;
  store: HistoryStore;
  providerId: string;
  accountKey: string;
  now: Date;
  live: Omit<DashboardProvider, "id" | "name" | "enabled">;
}): LocalUsageAnalytics | null {
  if (options.live.analytics) options.store.saveCollection?.(options.providerId, options.accountKey, options.live.analytics);
  options.store.saveCapacity?.(options.providerId, options.accountKey, options.live);
  const timeZone = options.timeZone ?? options.store.reportingTimeZone?.(options.providerId, options.accountKey);
  const today = localCalendarDay(options.now, timeZone);

  const analytics = options.live.analytics;
  // Failed or incomplete scans must leave old drafts eligible for backfill.
  if (analytics?.status === "available" || analytics?.status === "no_data")
    options.store.sealDraftsBefore(options.providerId, today);
  const canPersistAnalytics = analytics !== null
    && (analytics.status === "available" || analytics.status === "partial" || analytics.status === "no_data");
  const previousToday = options.store.get(options.providerId, options.accountKey, today);
  const preservedCapacity = preservedCapacityFields(options.live, previousToday?.payload ?? null);

  if (canPersistAnalytics && analytics) {
    const days = uniqueUsageDays(analytics);
    let persistedToday = false;
    for (const day of days) {
      if (day > today) continue;
      const includeWide = day === today;
      const payload = extractDayPayload(analytics, day, {
        accountKey: options.accountKey,
        timeZone,
        windows: day === today ? preservedCapacity.windows : [],
        identity: day === today ? preservedCapacity.identity : null,
        credits: day === today ? preservedCapacity.credits : null,
        source: options.live.source,
        capturedAt: options.live.updatedAt ?? options.now.toISOString(),
        includeCoverageWideBreakdowns: includeWide
      });
      if (day === today) {
        persistedToday = true;
        upsertTodayDraft(options, today, payload, preservedCapacity, previousToday);
        continue;
      }
      if (!hasUsageTotals(payload) && payload.windows.length === 0 && payload.status !== "no_data") continue;
      const previousDraft = options.store.get(options.providerId, options.accountKey, day);
      const sealedPayload: HistoryDayPayload = {
        ...payload,
        windows: payload.windows.length > 0
          ? payload.windows
          : previousDraft?.payload.windows ?? [],
        identity: payload.identity ?? previousDraft?.payload.identity ?? null,
        credits: payload.credits ?? previousDraft?.payload.credits ?? null
      };
      options.store.sealDay(options.providerId, options.accountKey, day, sealedPayload);
    }
    if (!persistedToday) {
      const payload = extractDayPayload(analytics, today, {
        accountKey: options.accountKey,
        timeZone,
        windows: preservedCapacity.windows,
        identity: preservedCapacity.identity,
        credits: preservedCapacity.credits,
        source: options.live.source,
        capturedAt: options.live.updatedAt ?? options.now.toISOString(),
        includeCoverageWideBreakdowns: true
      });
      upsertTodayDraft(options, today, payload, preservedCapacity, previousToday);
    }
  } else {
    upsertTodayCapacityOnly(options, today, preservedCapacity, previousToday);
  }

  return composeFromStore(
    options.store,
    options.providerId,
    options.accountKey,
    options.now,
    null
  );
}

export function composeFromStore(
  store: HistoryStore,
  providerId: string,
  accountKey: string,
  now: Date,
  liveToday: LocalUsageAnalytics | null
): LocalUsageAnalytics | null {
  const today = localCalendarDay(now, store.reportingTimeZone?.(providerId, accountKey));
  const startDay = shiftLocalDay(today, -(HISTORY_SNAPSHOT_DAYS - 1));
  const stored = store.getRange(providerId, startDay, today);
  if (stored.length === 0 && !liveToday) return null;
  return composeProviderAnalytics({
    now,
    stored,
    liveToday,
    currentAccountKey: accountKey,
    timeZone: store.reportingTimeZone?.(providerId, accountKey),
    historyDays: HISTORY_SNAPSHOT_DAYS
  });
}

export function historyDaysForAccount(
  store: HistoryStore,
  providerId: string,
  accountKey: string,
  now: Date
): number {
  const today = localCalendarDay(now, store.reportingTimeZone?.(providerId, accountKey));
  const startDay = shiftLocalDay(today, -(HISTORY_BACKFILL_DAYS - 1));
  if (store.needsCollectionRefresh?.(providerId, accountKey) || store.needsTimezoneRefresh?.(providerId, accountKey)) return HISTORY_BACKFILL_DAYS;
  const sealed = store.getRange(providerId, startDay, shiftLocalDay(today, -1))
    .filter((row) => row.accountKey === accountKey && row.sealed && hasUsageTotals(row.payload));
  if (sealed.length === 0) return HISTORY_BACKFILL_DAYS;
  const latest = sealed.reduce(
    (max, row) => row.localDay > max ? row.localDay : max,
    sealed[0]?.localDay ?? startDay
  );
  return lookbackDays(shiftLocalDay(latest, 1), today, HISTORY_BACKFILL_DAYS);
}

function uniqueUsageDays(analytics: LocalUsageAnalytics): string[] {
  const days = new Set<string>();
  for (const entry of analytics.daily) {
    days.add(entry.date);
  }
  for (const entry of analytics.hourly ?? []) {
    days.add(entry.date);
  }
  for (const entry of analytics.dailyModels) {
    days.add(entry.date);
  }
  return [...days].sort();
}

function preservedCapacityFields(
  live: Omit<DashboardProvider, "id" | "name" | "enabled">,
  previous: HistoryDayPayload | null
): Pick<HistoryDayPayload, "windows" | "identity" | "credits"> {
  const quotaFailed = Boolean(live.error) && live.windows.length === 0;
  if (quotaFailed && previous) {
    return {
      windows: previous.windows,
      identity: live.identity ?? previous.identity,
      credits: live.credits ?? previous.credits
    };
  }
  return {
    windows: live.windows,
    identity: live.identity ?? previous?.identity ?? null,
    credits: live.credits ?? previous?.credits ?? null
  };
}

function upsertTodayDraft(
  options: {
    store: HistoryStore;
    providerId: string;
    accountKey: string;
    live: Omit<DashboardProvider, "id" | "name" | "enabled">;
    now: Date;
  },
  today: string,
  payload: HistoryDayPayload,
  capacity: Pick<HistoryDayPayload, "windows" | "identity" | "credits">,
  previous: ReturnType<HistoryStore["get"]>
): void {
  const withWindows: HistoryDayPayload = {
    ...payload,
    windows: capacity.windows,
    identity: capacity.identity,
    credits: capacity.credits
  };
  if ((isEmptyHistoryPayload(withWindows) || withWindows.status === "no_data") && previous && hasUsageTotals(previous.payload)) {
    if (capacity.windows.length === 0) return;
    options.store.upsertDraft(options.providerId, options.accountKey, today, {
      ...previous.payload,
      windows: capacity.windows,
      identity: capacity.identity,
      credits: capacity.credits,
      capturedAt: options.live.updatedAt ?? options.now.toISOString()
    });
    return;
  }
  if (isEmptyHistoryPayload(withWindows) && (!previous || isEmptyHistoryPayload(previous.payload))) return;
  options.store.upsertDraft(options.providerId, options.accountKey, today, withWindows);
}

function upsertTodayCapacityOnly(
  options: {
    store: HistoryStore;
    providerId: string;
    accountKey: string;
    live: Omit<DashboardProvider, "id" | "name" | "enabled">;
    now: Date;
  },
  today: string,
  capacity: Pick<HistoryDayPayload, "windows" | "identity" | "credits">,
  previous: ReturnType<HistoryStore["get"]>
): void {
  if (!previous || capacity.windows.length === 0 || options.live.error) return;
  options.store.upsertDraft(options.providerId, options.accountKey, today, {
    ...previous.payload,
    windows: capacity.windows,
    identity: capacity.identity,
    credits: capacity.credits,
    capturedAt: options.live.updatedAt ?? options.now.toISOString()
  });
}
