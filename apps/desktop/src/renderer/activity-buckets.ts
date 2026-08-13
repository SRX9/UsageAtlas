import type { DashboardSnapshot, UsageHourlyMetric, UsageTotals } from "@usageatlas/contracts";
import { sumUsageTotals } from "./dashboard-model";
import { formatHourOfDay } from "./time-format";
import {
  inclusiveDayCount,
  type PeriodUsage,
  type ProviderScope,
  providersForScope,
  shiftDay,
  type UsageDay
} from "./personal-analytics";

export type ActivityGranularity = "hour" | "four-hour" | "day" | "multi-day";

export interface UsageActivityBucket extends UsageTotals {
  key: string;
  label: string;
  axisLabel: string;
  startDay: string;
  endDay: string;
  covered: boolean;
}

export interface ActivitySeries {
  buckets: UsageActivityBucket[];
  granularity: ActivityGranularity;
}

interface HourPoint {
  date: string;
  hour: number;
}

interface HourlySource {
  coverageStart: string;
  coverageEnd: string;
  byHour: Map<string, UsageHourlyMetric>;
}

export function buildActivitySeries(
  snapshot: DashboardSnapshot,
  scope: ProviderScope,
  period: PeriodUsage
): ActivitySeries {
  const dayCount = inclusiveDayCount(period.startDay, period.endDay);
  const reporting = providersForScope(snapshot, scope)
    .flatMap((provider) => provider.analytics ? [provider.analytics] : []);
  const hourlySources = reporting.flatMap<HourlySource>((analytics) => {
    if (!analytics || analytics.hourly === undefined) return [];
    return [{
      coverageStart: analytics.coverageStart,
      coverageEnd: analytics.coverageEnd,
      byHour: new Map(analytics.hourly.map((entry) => [hourKey(entry.date, entry.hour), entry]))
    }];
  });

  if (dayCount <= 2 && hourlySources.length > 0 && hourlySources.length === reporting.length) {
    return buildIntradaySeries(period, hourlySources, dayCount === 1 ? 1 : 4);
  }

  return buildDailySeries(period.days);
}

function buildIntradaySeries(
  period: PeriodUsage,
  sources: HourlySource[],
  hoursPerBucket: 1 | 4
): ActivitySeries {
  const points = hourPoints(period.startDay, period.endDay);
  const buckets: UsageActivityBucket[] = [];

  for (let index = 0; index < points.length; index += hoursPerBucket) {
    const slice = points.slice(index, index + hoursPerBucket);
    const first = slice[0];
    const last = slice.at(-1);
    if (!first || !last) continue;
    const entries: UsageHourlyMetric[] = [];
    let covered = false;

    for (const source of sources) {
      for (const point of slice) {
        if (point.date < source.coverageStart || point.date > source.coverageEnd) continue;
        covered = true;
        const entry = source.byHour.get(hourKey(point.date, point.hour));
        if (entry) entries.push(entry);
      }
    }

    buckets.push({
      key: `${hourKey(first.date, first.hour)}-${hourKey(last.date, last.hour)}`,
      label: hoursPerBucket === 1 ? formatHour(first) : formatFourHourRange(first),
      axisLabel: hoursPerBucket === 1 ? formatAxisHour(first) : formatFourHourAxisLabel(first),
      startDay: first.date,
      endDay: last.date,
      covered,
      ...sumUsageTotals(entries)
    });
  }

  return { buckets, granularity: hoursPerBucket === 1 ? "hour" : "four-hour" };
}

function buildDailySeries(days: UsageDay[]): ActivitySeries {
  const daysPerBucket = days.length <= 14 ? 1 : days.length <= 45 ? 2 : days.length <= 120 ? 7 : 14;
  const buckets: UsageActivityBucket[] = [];

  for (let index = 0; index < days.length; index += daysPerBucket) {
    const slice = days.slice(index, index + daysPerBucket);
    const first = slice[0];
    const last = slice.at(-1);
    if (!first || !last) continue;
    buckets.push({
      key: `${first.date}-${last.date}`,
      label: first.date === last.date
        ? formatDay(first.date)
        : `${formatDay(first.date)} - ${formatDay(last.date)}`,
      axisLabel: formatDay(first.date),
      startDay: first.date,
      endDay: last.date,
      covered: slice.some((day) => day.covered),
      ...sumUsageTotals(slice)
    });
  }

  return { buckets, granularity: daysPerBucket === 1 ? "day" : "multi-day" };
}

function hourPoints(startDay: string, endDay: string): HourPoint[] {
  const points: HourPoint[] = [];
  for (let date = startDay; date <= endDay; date = shiftDay(date, 1)) {
    for (let hour = 0; hour < 24; hour += 1) points.push({ date, hour });
  }
  return points;
}

function hourKey(date: string, hour: number): string {
  return `${date}T${String(hour).padStart(2, "0")}`;
}

function formatHour(point: HourPoint): string {
  return formatHourOfDay(point.hour);
}

function formatFourHourRange(point: HourPoint): string {
  const start = formatHour(point);
  const end = formatHourOfDay(point.hour + 4);
  return `${formatDay(point.date)}, ${start}-${end}`;
}

function formatFourHourAxisLabel(point: HourPoint): string {
  return point.hour === 0 ? formatDay(point.date) : formatAxisHour(point);
}

function formatAxisHour(point: HourPoint): string {
  return formatHourOfDay(point.hour);
}

function formatDay(day: string): string {
  return dayFormatter.format(new Date(`${day}T12:00:00`));
}

const dayFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
