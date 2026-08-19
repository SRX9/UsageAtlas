import type { DashboardProvider, DashboardSnapshot, UsageBreakdown, UsageTotals } from "@usageatlas/contracts";
import { sumUsageTotals } from "./dashboard-model";
import { inclusiveDayCount, type ProviderScope, providersForScope } from "./personal-analytics";
import { formatHourOfDay } from "./time-format";

export type UsagePersonaKind = "morning" | "afternoon" | "evening" | "night";

export interface UsagePersona {
  kind: UsagePersonaKind;
  label: string;
  description: string;
  share: number;
}

export interface DaypartInsight {
  id: UsagePersonaKind;
  label: string;
  rangeLabel: string;
  totalTokens: number;
  share: number;
}

export interface ModelProviderUsage {
  id: string;
  name: string;
  totalTokens: number;
  /** Percent of that provider's own model volume spent on this model. */
  share: number;
}

export interface ModelInsight extends UsageTotals {
  id: string;
  label: string;
  providerNames: string[];
  /** Per-provider split, busiest first — the radar plots one series per entry. */
  providers: ModelProviderUsage[];
  share: number;
}

export interface ModelProviderInsight {
  id: string;
  name: string;
  totalTokens: number;
}

/** Which models the connected tools reached for over the requested days. */
export interface ModelMix {
  models: ModelInsight[];
  modelProviders: ModelProviderInsight[];
  totalModelTokens: number;
  topModel: ModelInsight | null;
}

export interface HourBlockInsight {
  hour: number;
  label: string;
  totalTokens: number;
  intensity: 0 | 1 | 2 | 3 | 4;
}

export interface WeekdayInsight {
  index: number;
  label: string;
  shortLabel: string;
  totalTokens: number;
  share: number;
  hourBlocks: HourBlockInsight[];
}

export interface UsageInsights extends ModelMix {
  coverageStart: string | null;
  coverageEnd: string | null;
  coverageDays: number;
  activeHours: number;
  hourlyHistoryAvailable: boolean;
  totalHourlyTokens: number;
  peakHour: number | null;
  persona: UsagePersona | null;
  dayparts: DaypartInsight[];
  weekdays: WeekdayInsight[];
  busiestWeekday: WeekdayInsight | null;
}

interface TotalsGroup {
  totals: UsageTotals[];
}

interface ModelGroup {
  id: string;
  label: string;
  byProvider: Map<string, UsageTotals[]>;
}

interface HourlyPoint {
  date: string;
  hour: number;
  totals: UsageTotals;
}

const daypartDefinitions: Array<{
  id: UsagePersonaKind;
  label: string;
  rangeLabel: string;
  includes(hour: number): boolean;
}> = [
  { id: "morning", label: "Morning", rangeLabel: "5 AM–11:59 AM", includes: (hour) => hour >= 5 && hour < 12 },
  { id: "afternoon", label: "Afternoon", rangeLabel: "Noon–4:59 PM", includes: (hour) => hour >= 12 && hour < 17 },
  { id: "evening", label: "Evening", rangeLabel: "5 PM–9:59 PM", includes: (hour) => hour >= 17 && hour < 22 },
  { id: "night", label: "Late night", rangeLabel: "10 PM–4:59 AM", includes: (hour) => hour >= 22 || hour < 5 }
];

const weekdayLabels = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
/** A radar stops being readable past eight spokes, so the mix keeps the top eight. */
const maxVisibleModels = 8;

/**
 * The model mix over `days`, or over every collected day when no range is given.
 * A range reads the per-day model rows the scanner records; the all-day form reads the
 * totals, which are the same rows already summed.
 */
export function buildModelMix(
  snapshot: DashboardSnapshot,
  scope: ProviderScope,
  days?: { startDay: string; endDay: string }
): ModelMix {
  return modelMixOf(
    providersForScope(snapshot, scope).filter((provider) => provider.analytics !== null),
    days
  );
}

function modelEntriesOf(
  provider: DashboardProvider,
  days?: { startDay: string; endDay: string }
): UsageBreakdown[] {
  const analytics = provider.analytics;
  if (!analytics) return [];
  if (!days) return analytics.models;
  return analytics.dailyModels.filter((row) => row.date >= days.startDay && row.date <= days.endDay);
}

function modelMixOf(providers: DashboardProvider[], days?: { startDay: string; endDay: string }): ModelMix {
  const groups = new Map<string, ModelGroup>();
  const namesById = new Map<string, string>();
  for (const provider of providers) {
    namesById.set(provider.id, provider.name);
    for (const entry of modelEntriesOf(provider, days)) {
      const key = entry.label.trim().toLocaleLowerCase();
      const group = groups.get(key) ?? {
        id: entry.id,
        label: entry.label,
        byProvider: new Map<string, UsageTotals[]>()
      };
      const forProvider = group.byProvider.get(provider.id) ?? [];
      forProvider.push(entry);
      group.byProvider.set(provider.id, forProvider);
      groups.set(key, group);
    }
  }

  const { models, modelProviders } = buildModels(groups, namesById);
  return {
    models,
    modelProviders,
    totalModelTokens: models.reduce((total, model) => total + model.totalTokens, 0),
    topModel: models.find((model) => model.id !== "other") ?? null
  };
}

export function buildUsageInsights(snapshot: DashboardSnapshot, scope: ProviderScope): UsageInsights {
  const providers = providersForScope(snapshot, scope).filter((provider) => provider.analytics !== null);
  const analytics = providers.flatMap((provider) => provider.analytics ? [provider.analytics] : []);
  const coverageStart = analytics.reduce<string | null>(
    (earliest, item) => earliest === null || item.coverageStart < earliest ? item.coverageStart : earliest,
    null
  );
  const coverageEnd = analytics.reduce<string | null>(
    (latest, item) => latest === null || item.coverageEnd > latest ? item.coverageEnd : latest,
    null
  );
  const hourlyGroups = new Map<string, { date: string; hour: number; totals: UsageTotals[] }>();
  const dailyGroups = new Map<string, TotalsGroup>();

  for (const provider of providers) {
    const item = provider.analytics;
    if (!item) continue;

    for (const entry of item.hourly ?? []) {
      const key = `${entry.date}T${String(entry.hour).padStart(2, "0")}`;
      const group = hourlyGroups.get(key) ?? { date: entry.date, hour: entry.hour, totals: [] };
      group.totals.push(entry);
      hourlyGroups.set(key, group);
    }

    for (const entry of item.daily) {
      const group = dailyGroups.get(entry.date) ?? { totals: [] };
      group.totals.push(entry);
      dailyGroups.set(entry.date, group);
    }
  }

  const hourlyPoints = [...hourlyGroups.values()].map<HourlyPoint>((group) => ({
    date: group.date,
    hour: group.hour,
    totals: sumUsageTotals(group.totals)
  }));
  const totalHourlyTokens = hourlyPoints.reduce((total, point) => total + point.totals.totalTokens, 0);
  const dayparts = buildDayparts(hourlyPoints, totalHourlyTokens);
  const persona = buildPersona(dayparts, totalHourlyTokens);
  const peakHour = buildPeakHour(hourlyPoints);
  const weekdays = buildWeekdays(dailyGroups, hourlyPoints);

  return {
    ...modelMixOf(providers),
    coverageStart,
    coverageEnd,
    coverageDays: coverageStart && coverageEnd ? inclusiveDayCount(coverageStart, coverageEnd) : 0,
    activeHours: hourlyPoints.filter((point) => point.totals.totalTokens > 0).length,
    hourlyHistoryAvailable: analytics.some((item) => item.hourly !== undefined),
    totalHourlyTokens,
    peakHour,
    persona,
    dayparts,
    weekdays,
    busiestWeekday: maxByTokens(weekdays)
  };
}

function buildDayparts(points: HourlyPoint[], totalTokens: number): DaypartInsight[] {
  return daypartDefinitions.map((definition) => {
    const value = points.reduce(
      (total, point) => total + (definition.includes(point.hour) ? point.totals.totalTokens : 0),
      0
    );
    return {
      id: definition.id,
      label: definition.label,
      rangeLabel: definition.rangeLabel,
      totalTokens: value,
      share: percentage(value, totalTokens)
    };
  });
}

function buildPersona(dayparts: DaypartInsight[], totalTokens: number): UsagePersona | null {
  if (totalTokens <= 0) return null;
  const dominant = maxByTokens(dayparts);
  if (!dominant) return null;
  const copy: Record<UsagePersonaKind, Pick<UsagePersona, "label" | "description">> = {
    morning: {
      label: "Morning starter",
      description: "Your highest token volume lands between 5 AM and noon."
    },
    afternoon: {
      label: "Daylight regular",
      description: "Your highest token volume lands between noon and 5 PM."
    },
    evening: {
      label: "Evening builder",
      description: "Your highest token volume lands between 5 PM and 10 PM."
    },
    night: {
      label: "Night owl",
      description: "Your highest token volume lands between 10 PM and 5 AM."
    }
  };
  return { kind: dominant.id, share: dominant.share, ...copy[dominant.id] };
}

function buildPeakHour(points: HourlyPoint[]): number | null {
  const totals = Array.from({ length: 24 }, () => 0);
  for (const point of points) totals[point.hour] = (totals[point.hour] ?? 0) + point.totals.totalTokens;
  let peakHour: number | null = null;
  let peakTokens = 0;
  for (let hour = 0; hour < totals.length; hour += 1) {
    const value = totals[hour] ?? 0;
    if (value > peakTokens) {
      peakTokens = value;
      peakHour = hour;
    }
  }
  return peakHour;
}

function buildModels(
  groups: Map<string, ModelGroup>,
  namesById: Map<string, string>
): {
  models: ModelInsight[];
  modelProviders: ModelProviderInsight[];
} {
  const allModels = [...groups.values()].map((group) => ({
    id: group.id,
    label: group.label,
    byProvider: new Map(
      [...group.byProvider].map(([id, totals]) => [id, sumUsageTotals(totals).totalTokens])
    ),
    ...sumUsageTotals([...group.byProvider.values()].flat())
  })).filter((model) => model.totalTokens > 0)
    .sort((left, right) => right.totalTokens - left.totalTokens);
  const totalTokens = allModels.reduce((total, model) => total + model.totalTokens, 0);
  const visible = allModels.slice(0, maxVisibleModels);
  const remainder = allModels.slice(maxVisibleModels);
  const rows = remainder.length === 0 ? visible : [
    ...visible,
    {
      id: "other",
      label: "Other models",
      byProvider: mergeProviderTokens(remainder.map((model) => model.byProvider)),
      ...sumUsageTotals(remainder)
    }
  ];
  // Each provider's own volume is the denominator for its model shares, so one
  // busy tool cannot flatten the profile of a quieter one on the radar.
  const providerTotals = mergeProviderTokens(allModels.map((model) => model.byProvider));
  const modelProviders = [...providerTotals]
    .map(([id, providerTokens]) => ({
      id,
      name: namesById.get(id) ?? id,
      totalTokens: providerTokens
    }))
    .sort((left, right) => right.totalTokens - left.totalTokens);

  return {
    models: rows.map(({ byProvider, ...model }) => {
      const providers = [...byProvider]
        .map((entry) => ({
          id: entry[0],
          name: namesById.get(entry[0]) ?? entry[0],
          totalTokens: entry[1],
          share: percentage(entry[1], providerTotals.get(entry[0]) ?? 0)
        }))
        .sort((left, right) => right.totalTokens - left.totalTokens);
      return {
        ...model,
        providerNames: providers
          .map((provider) => provider.name)
          .sort((left, right) => left.localeCompare(right)),
        providers,
        share: percentage(model.totalTokens, totalTokens)
      };
    }),
    modelProviders
  };
}

function mergeProviderTokens(maps: Map<string, number>[]): Map<string, number> {
  const merged = new Map<string, number>();
  for (const map of maps) {
    for (const [name, tokens] of map) merged.set(name, (merged.get(name) ?? 0) + tokens);
  }
  return merged;
}

function buildWeekdays(dailyGroups: Map<string, TotalsGroup>, hourlyPoints: HourlyPoint[]): WeekdayInsight[] {
  const dailyTotals = Array.from({ length: 7 }, () => 0);
  for (const [date, group] of dailyGroups) {
    const index = weekdayIndex(date);
    dailyTotals[index] = (dailyTotals[index] ?? 0) + sumUsageTotals(group.totals).totalTokens;
  }

  const hourlyTotals = Array.from({ length: 7 }, () => Array.from({ length: 12 }, () => 0));
  for (const point of hourlyPoints) {
    const weekday = weekdayIndex(point.date);
    const block = Math.floor(point.hour / 2);
    const row = hourlyTotals[weekday];
    if (row) row[block] = (row[block] ?? 0) + point.totals.totalTokens;
  }
  const peakCell = hourlyTotals.reduce(
    (peak, row) => Math.max(peak, ...row),
    0
  );
  const totalTokens = dailyTotals.reduce((total, value) => total + value, 0);

  return weekdayLabels.map((label, index) => ({
    index,
    label,
    shortLabel: label.slice(0, 3),
    totalTokens: dailyTotals[index] ?? 0,
    share: percentage(dailyTotals[index] ?? 0, totalTokens),
    hourBlocks: Array.from({ length: 12 }, (_, block) => {
      const tokens = hourlyTotals[index]?.[block] ?? 0;
      return {
        hour: block * 2,
        label: formatHourBlock(block * 2),
        totalTokens: tokens,
        intensity: intensity(tokens, peakCell)
      };
    })
  }));
}

function weekdayIndex(date: string): number {
  return (new Date(`${date}T12:00:00`).getDay() + 6) % 7;
}

function formatHourBlock(hour: number): string {
  const start = formatHourOfDay(hour);
  const end = formatHourOfDay(hour + 2);
  return `${start}–${end}`;
}

function intensity(value: number, peak: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || peak <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / peak) * 4))) as 1 | 2 | 3 | 4;
}

function percentage(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function maxByTokens<T extends { totalTokens: number }>(rows: T[]): T | null {
  let peak: T | null = null;
  for (const row of rows) {
    if (!peak || row.totalTokens > peak.totalTokens) peak = row;
  }
  return peak?.totalTokens ? peak : null;
}
