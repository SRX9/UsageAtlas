import type { DashboardSnapshot } from "@usageatlas/contracts";
import { Button, Card, Tooltip } from "@heroui/react";
import { buildActivitySeries } from "../activity-buckets";
import type { AnalyticsRange, ProviderScope } from "../personal-analytics";
import {
  baselinePercent,
  buildBaseline,
  buildPeriodUsage,
  costPresentation,
  enabledProviders,
  providersForScope,
  shiftDay,
  tokenComposition
} from "../personal-analytics";
import { formatCompactNumber, formatCost, formatExactTokens } from "../number-format";
import { RefreshIcon } from "../icons";
import { AnalyzerNotice, type PageNotice } from "./UsagePageState";
import { ProviderScopeSelect, TimeNavigator } from "./AnalyzerControls";
import { LimitsPreviewCard } from "./CapacityMeters";
import { ProviderLogo } from "./ProviderLogo";
import { TrendChip } from "./UsagePrimitives";
import {
  ActivityComposedChart,
  ProviderDonut,
  StatTile,
  TokenMixChart
} from "./HeroMetrics";

interface DayDashboardProps {
  snapshot: DashboardSnapshot;
  selectedDay: string;
  today: string;
  providerScope: ProviderScope;
  limitOrder: string[];
  refreshing: boolean;
  notice: PageNotice | null;
  onSelectDay(day: string): void;
  onSelectRange(range: AnalyticsRange): void;
  onProviderScopeChange(scope: ProviderScope): void;
  onOpenLimits(): void;
  onRefresh(): Promise<void>;
}

export function DayDashboard({
  snapshot,
  selectedDay,
  today,
  providerScope,
  limitOrder,
  refreshing,
  notice,
  onSelectDay,
  onSelectRange,
  onProviderScopeChange,
  onOpenLimits,
  onRefresh
}: DayDashboardProps): React.JSX.Element {
  const period = buildPeriodUsage(snapshot, providerScope, selectedDay, selectedDay);
  const cost = costPresentation(period);
  const activity = buildActivitySeries(snapshot, providerScope, period);
  const baseline = buildBaseline(snapshot, providerScope, selectedDay);
  const baselineValue = baselinePercent(period.totals.totalTokens, baseline.averageTokens);
  const baselineChange = baselineValue === null ? null : baselineValue - 100;
  const baselineTrend = baselineChange === null || baselineChange === 0
    ? "neutral"
    : baselineChange > 0 ? "up" : "down";
  const providers = providersForScope(snapshot, providerScope);
  const comparison = baselineValue === null
    ? "We’ll compare this day after enough history is collected."
    : `${Math.abs(baselineValue - 100)}% ${baselineValue >= 100 ? "above" : "below"} your ${baseline.days}-day baseline.`;

  return (
    <div className="atlas-page">
      <div className="atlas-toolbar">
        <TimeNavigator
          canMoveForward={selectedDay < today}
          label={dayNavigatorLabel(selectedDay, today)}
          mode="day"
          onMoveBack={() => onSelectDay(shiftDay(selectedDay, -1))}
          onMoveForward={() => onSelectDay(shiftDay(selectedDay, 1))}
          onSelectDay={onSelectDay}
          onSelectRange={onSelectRange}
          selectedDay={selectedDay}
        />
        <div className="atlas-toolbar-actions">
          <ProviderScopeSelect
            onChange={onProviderScopeChange}
            providers={enabledProviders(snapshot)}
            value={providerScope}
          />
          <Tooltip>
            <Button className="atlas-toolbar-icon" aria-label="Refresh usage" isIconOnly isPending={refreshing} onPress={() => void onRefresh()} variant="secondary">
              <RefreshIcon />
            </Button>
            <Tooltip.Content>Refresh usage</Tooltip.Content>
          </Tooltip>
        </div>
      </div>

      {notice ? <AnalyzerNotice {...notice} /> : null}

      <header className="atlas-hero-grid">
        <Card className="atlas-primary-card" variant="transparent">
          <Card.Content className="flex h-full flex-col justify-between gap-7 p-7">
            <div>
              <p className="atlas-kicker">{longDay(selectedDay)}</p>
              <h1 className="atlas-page-title">Your AI usage</h1>
            </div>
            <div className="atlas-hero-metric">
              <p className="atlas-hero-metric-label">Total tokens</p>
              <strong
                aria-label={formatExactTokens(period.totals.totalTokens)}
                className="atlas-hero-value"
                title={formatExactTokens(period.totals.totalTokens)}
              >
                {formatCompactNumber(period.totals.totalTokens)}
              </strong>
              <TrendChip
                aria-label={comparison}
                className="mt-3"
                trend={baselineTrend}
                variant="tertiary"
              >
                {baselineChange === null
                  ? "No baseline yet"
                  : `${baselineChange > 0 ? "+" : ""}${baselineChange}%`}
                {baselineChange === null
                  ? null
                  : <TrendChip.Suffix>vs {baseline.days}-day baseline</TrendChip.Suffix>}
              </TrendChip>
            </div>
            {period.providerRows.length > 0 ? (
              <div
                aria-label={`${period.reportingProviders} ${period.reportingProviders === 1 ? "source" : "sources"} reporting`}
                className="atlas-source-avatars"
                role="group"
              >
                {period.providerRows.map((provider) => (
                  <Tooltip delay={250} key={provider.id}>
                    <Tooltip.Trigger aria-label={`${provider.name} reporting`} className="atlas-source-avatar">
                      <ProviderLogo compact providerID={provider.id} providerName={provider.name} />
                    </Tooltip.Trigger>
                    <Tooltip.Content>{provider.name}</Tooltip.Content>
                  </Tooltip>
                ))}
              </div>
            ) : (
              <span className="text-xs text-muted">No sources reporting</span>
            )}
          </Card.Content>
        </Card>
        <LimitsPreviewCard limitOrder={limitOrder} onOpenAll={onOpenLimits} providers={providers} />
      </header>

      <section className="atlas-metric-strip atlas-metric-strip--compact" aria-label="Daily usage summary">
        <StatTile
          detail={baseline.averageRequests > 0 ? `${comparisonAgainst(period.totals.requests, baseline.averageRequests)} vs usual` : "Daily activity"}
          label="Requests"
          series={activity.buckets.map((bucket) => bucket.requests)}
          value={formatCompactNumber(period.totals.requests)}
        />
        <StatTile
          detail={cost.detail}
          label={cost.label}
          series={cost.unavailableReason ? undefined : activity.buckets.map((bucket) => bucket.estimatedCostUSD ?? 0)}
          value={formatCost(period.totals.estimatedCostUSD)}
        />
      </section>


      <section className="atlas-section" aria-labelledby="day-rhythm-heading">
        <div className="atlas-section-heading">
          <div><p className="atlas-kicker">Selected date</p><h2 id="day-rhythm-heading">Usage through the day</h2></div>
          <p>{activity.granularity === "hour"
            ? `Hourly totals for ${longDay(selectedDay)}.`
            : `Collected activity for ${longDay(selectedDay)}. Refresh to load hourly detail.`}</p>
        </div>
        <ActivityComposedChart series={activity} />
      </section>

      <section className="atlas-section atlas-content-grid">
        <Card variant="transparent">
          <Card.Header><Card.Title>Provider mix</Card.Title><Card.Description>Where the day’s tracked load went</Card.Description></Card.Header>
          <Card.Content><ProviderDonut rows={period.providerRows} /></Card.Content>
        </Card>
        <Card variant="transparent">
          <Card.Header><Card.Title>Token mix</Card.Title><Card.Description>How the selected day was composed</Card.Description></Card.Header>
          <Card.Content>
            <TokenMixChart composition={tokenComposition(period.totals)} />
          </Card.Content>
        </Card>
      </section>
    </div>
  );
}

function dayNavigatorLabel(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === shiftDay(today, -1)) return "Yesterday";
  return navigatorDayFormatter.format(new Date(`${day}T12:00:00`));
}

function longDay(day: string): string {
  return longDayFormatter.format(new Date(`${day}T12:00:00`));
}

function comparisonAgainst(value: number, baseline: number): string {
  if (baseline <= 0) return "No baseline";
  const change = Math.round(((value - baseline) / baseline) * 100);
  if (change === 0) return "On pace";
  return `${Math.abs(change)}% ${change > 0 ? "above" : "below"}`;
}

const navigatorDayFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const longDayFormatter = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
