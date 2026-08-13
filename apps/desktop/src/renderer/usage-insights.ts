import type { DashboardSnapshot, UsageTotals } from "@usageatlas/contracts";
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

export interface ModelInsight extends UsageTotals {
  id: string;
  label: string;
  providerNames: string[];
  share: number;
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

export interface UsageInsights {
  coverageStart: string | null;
  coverageEnd: string | null;
  coverageDays: number;
  activeHours: number;
  hourlyHistoryAvailable: boolean;
  totalHourlyTokens: number;
  peakHour: number | null;
  persona: UsagePersona | null;
  dayparts: DaypartInsight[];
  models: ModelInsight[];
  totalModelTokens: number;
  topModel: ModelInsight | null;
  weekdays: WeekdayInsight[];
  busiestWeekday: WeekdayInsight | null;
}

interface TotalsGroup {
  totals: UsageTotals[];
}

interface ModelGroup extends TotalsGroup {
  id: string;
  label: string;
  providerNames: Set<string>;
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
const maxVisibleModels = 5;

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
  const modelGroups = new Map<string, ModelGroup>();
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

    for (const entry of item.models) {
      const key = entry.label.trim().toLocaleLowerCase();
      const group = modelGroups.get(key) ?? {
        id: entry.id,
        label: entry.label,
        providerNames: new Set<string>(),
        totals: []
      };
      group.providerNames.add(provider.name);
      group.totals.push(entry);
      modelGroups.set(key, group);
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
  const models = buildModels(modelGroups);
  const totalModelTokens = models.reduce((total, model) => total + model.totalTokens, 0);
  const weekdays = buildWeekdays(dailyGroups, hourlyPoints);

  return {
    coverageStart,
    coverageEnd,
    coverageDays: coverageStart && coverageEnd ? inclusiveDayCount(coverageStart, coverageEnd) : 0,
    activeHours: hourlyPoints.filter((point) => point.totals.totalTokens > 0).length,
    hourlyHistoryAvailable: analytics.some((item) => item.hourly !== undefined),
    totalHourlyTokens,
    peakHour,
    persona,
    dayparts,
    models,
    totalModelTokens,
    topModel: models.find((model) => model.id !== "other") ?? null,
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

function buildModels(groups: Map<string, ModelGroup>): ModelInsight[] {
  const allModels = [...groups.values()].map((group) => ({
    id: group.id,
    label: group.label,
    providerNames: [...group.providerNames].sort((left, right) => left.localeCompare(right)),
    ...sumUsageTotals(group.totals)
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
      providerNames: [...new Set(remainder.flatMap((model) => model.providerNames))].sort((left, right) => left.localeCompare(right)),
      ...sumUsageTotals(remainder)
    }
  ];
  return rows.map((model) => ({ ...model, share: percentage(model.totalTokens, totalTokens) }));
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
