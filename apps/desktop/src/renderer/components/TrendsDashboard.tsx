import type { DashboardSnapshot } from "@usageatlas/contracts";
import { Button, Card, Tooltip } from "@heroui/react";
import { useState } from "react";
import { buildActivitySeries } from "../activity-buckets";
import { RefreshIcon } from "../icons";
import { formatCompactNumber, formatCost, formatTokens } from "../number-format";
import type { AnalyticsRange, ProviderScope } from "../personal-analytics";
import {
  buildPeriodUsage,
  costPresentation,
  enabledProviders,
  formatPeriodLabel,
  peakUsageDay,
  percentageChange,
  periodBounds,
  previousPeriod,
  tokenComposition
} from "../personal-analytics";
import { ComparisonToggle } from "./TrendControls";
import { AnalyzerNotice, type PageNotice } from "./UsagePageState";
import { ProviderScopeSelect, TimeNavigator } from "./AnalyzerControls";
import { ProviderDonut, SeriesChart, StatTile, TokenMixChart } from "./HeroMetrics";

interface TrendsDashboardProps {
  snapshot: DashboardSnapshot;
  range: AnalyticsRange;
  endDay: string;
  today: string;
  providerScope: ProviderScope;
  refreshing: boolean;
  notice: PageNotice | null;
  onRangeChange(range: AnalyticsRange): void;
  onEndDayChange(day: string): void;
  onOpenDay(day: string): void;
  onProviderScopeChange(scope: ProviderScope): void;
  onRefresh(): Promise<void>;
}

export function TrendsDashboard({
  snapshot,
  range,
  endDay,
  today,
  providerScope,
  refreshing,
  notice,
  onRangeChange,
  onEndDayChange,
  onOpenDay,
  onProviderScopeChange,
  onRefresh
}: TrendsDashboardProps): React.JSX.Element {
  const [showComparison, setShowComparison] = useState(true);
  const bounds = periodBounds(snapshot, providerScope, endDay, range);
  const period = buildPeriodUsage(snapshot, providerScope, bounds.startDay, bounds.endDay);
  const cost = costPresentation(period);
  const activity = buildActivitySeries(snapshot, providerScope, period);
  const priorBounds = previousPeriod(period);
  const prior = buildPeriodUsage(snapshot, providerScope, priorBounds.startDay, priorBounds.endDay);
  const peak = peakUsageDay(period.days);
  const activeDays = period.days.filter((day) => day.totalTokens > 0).length;
  const divisor = Math.max(1, period.coveredDays);
  const tokenChange = percentageChange(period.totals.totalTokens, prior.totals.totalTokens);
  const costChange = period.totals.estimatedCostUSD !== null && prior.totals.estimatedCostUSD !== null
    ? percentageChange(period.totals.estimatedCostUSD, prior.totals.estimatedCostUSD)
    : null;
  const requestChange = percentageChange(period.totals.requests, prior.totals.requests);
  const canMove = range !== "all";
  const step = range === "all" ? 0 : range;

  return (
    <div className="atlas-page">
      <div className="atlas-toolbar">
        <TimeNavigator
          canMoveBack={canMove}
          canMoveForward={canMove && endDay < today}
          label={rangeLabel(range, endDay, today, bounds.startDay)}
          mode="range"
          onMoveBack={() => onEndDayChange(shiftBy(endDay, -step))}
          onMoveForward={() => onEndDayChange(minDay(today, shiftBy(endDay, step)))}
          onSelectDay={onOpenDay}
          onSelectRange={onRangeChange}
          selectedDay={endDay}
          selectedRange={range}
        />
        <div className="atlas-toolbar-actions">
          <ComparisonToggle checked={showComparison} onChange={setShowComparison} />
          <ProviderScopeSelect
            onChange={onProviderScopeChange}
            providers={enabledProviders(snapshot)}
            value={providerScope}
          />
          <Tooltip>
            <Button className="atlas-toolbar-icon" aria-label="Refresh usage" isIconOnly isPending={refreshing} onPress={() => void onRefresh()} variant="secondary"><RefreshIcon /></Button>
            <Tooltip.Content>Refresh usage</Tooltip.Content>
          </Tooltip>
        </div>
      </div>

      {notice ? <AnalyzerNotice {...notice} /> : null}

      <header className="atlas-page-header">
        <p className="atlas-kicker">Collected history</p>
        <h1 className="atlas-page-title">{formatPeriodLabel(range)}</h1>
        <p className="atlas-hero-description">How your AI usage changes over time on this computer.</p>
      </header>

      <section className="atlas-metric-strip" aria-label="Trend summary">
        <StatTile
          detail={`${activeDays} active days`}
          label="Tokens"
          series={activity.buckets.map((bucket) => bucket.totalTokens)}
          trend={showComparison ? tokenChange : undefined}
          value={formatTokens(period.totals.totalTokens)}
        />
        <StatTile
          detail={cost.detail}
          label={cost.label}
          series={cost.unavailableReason ? undefined : activity.buckets.map((bucket) => bucket.estimatedCostUSD ?? 0)}
          trend={cost.unavailableReason ? undefined : showComparison ? costChange : undefined}
          value={formatCost(period.totals.estimatedCostUSD)}
        />
        <StatTile
          detail={`${activeDays} of ${period.coveredDays || period.days.length} covered days`}
          label="Requests"
          series={activity.buckets.map((bucket) => bucket.requests)}
          trend={showComparison ? requestChange : undefined}
          value={formatCompactNumber(period.totals.requests)}
        />
        <StatTile
          detail={peak ? longDay(peak.date) : "No active day yet"}
          label="Peak day"
          value={peak ? formatTokens(peak.totalTokens) : "—"}
        />
      </section>

      <section className="atlas-section" aria-labelledby="trend-lines-heading">
        <div className="atlas-section-heading">
          <div><p className="atlas-kicker">Over time</p><h2 id="trend-lines-heading">Load and spend</h2></div>
          <p>{formatCoverage(period.coverageStart, period.coverageEnd, period.coveredDays)}</p>
        </div>
        <div className="atlas-content-grid">
          <SeriesChart buckets={activity.buckets} kind="tokens" title="Token load" />
          <SeriesChart
            buckets={activity.buckets}
            kind="cost"
            title={cost.label}
            unavailableReason={cost.unavailableReason}
          />
        </div>
      </section>

      <section className="atlas-section atlas-content-grid">
        <Card variant="transparent">
          <Card.Header><Card.Title>Provider mix</Card.Title><Card.Description>Distribution across connected tools</Card.Description></Card.Header>
          <Card.Content><ProviderDonut rows={period.providerRows} /></Card.Content>
        </Card>
        <Card variant="transparent">
          <Card.Header><Card.Title>How tokens were used</Card.Title><Card.Description>Composition across the selected period</Card.Description></Card.Header>
          <Card.Content className="space-y-6">
            <TokenMixChart composition={tokenComposition(period.totals)} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Card variant="secondary"><Card.Content className="p-4"><span className="text-xs text-muted">Average per covered day</span><strong className="mt-2 block text-xl">{formatTokens(period.totals.totalTokens / divisor)}</strong></Card.Content></Card>
              <Card variant="secondary"><Card.Content className="p-4"><span className="text-xs text-muted">Requests per covered day</span><strong className="mt-2 block text-xl">{formatCompactNumber(period.totals.requests / divisor)}</strong></Card.Content></Card>
            </div>
          </Card.Content>
        </Card>
      </section>

      <p className="atlas-footnote">Coverage note: empty space outside collected source history is unavailable data, not zero usage.</p>
    </div>
  );
}

function rangeLabel(range: AnalyticsRange, endDay: string, today: string, startDay: string): string {
  if (range === "all") return "All available";
  if (endDay === today) return formatPeriodLabel(range);
  return `${shortDay(startDay)} – ${shortDay(endDay)}`;
}

function shiftBy(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + offset);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const value = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${value}`;
}

function minDay(left: string, right: string): string { return left < right ? left : right; }

function shortDay(day: string): string {
  return shortDayFormatter.format(new Date(`${day}T12:00:00`));
}

function longDay(day: string): string {
  return longDayFormatter.format(new Date(`${day}T12:00:00`));
}

function formatCoverage(start: string | null, end: string | null, days: number): string {
  if (!start || !end) return "No provider history is available for this selection.";
  return `${days} covered days · ${shortDay(start)} – ${shortDay(end)}`;
}

const shortDayFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const longDayFormatter = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
