import type { DashboardSnapshot } from "@usageatlas/contracts";
import { Button, Card, Skeleton, Tooltip } from "@heroui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DayIcon, HistoryIcon, MoonIcon, ProvidersIcon, RefreshIcon, SunIcon } from "../icons";
import { formatCompactNumber, formatExactTokens, formatTokens } from "../number-format";
import type { ProviderScope } from "../personal-analytics";
import { formatHourOfDay } from "../time-format";
import {
  buildUsageInsights,
  type HourBlockInsight,
  type ModelInsight,
  type UsageInsights,
  type WeekdayInsight
} from "../usage-insights";
import { AnalyzerNotice, type PageNotice } from "./UsagePageState";
import { ProviderScopeSelect } from "./AnalyzerControls";
import type { ChartConfig } from "./dither-kit/chart-context";
import { type DitherColor, rgb, seedOfColor } from "./dither-kit/palette";
import { Pie } from "./dither-kit/pie";
import { PieChart } from "./dither-kit/pie-chart";
import { Tooltip as ChartTooltip } from "./dither-kit/tooltip";

interface InsightsDashboardProps {
  snapshot: DashboardSnapshot;
  providerScope: ProviderScope;
  refreshing: boolean;
  notice: PageNotice | null;
  onProviderScopeChange(scope: ProviderScope): void;
  onRefresh(): Promise<void>;
}

const chartPalette: DitherColor[] = ["green", "blue", "purple", "orange", "pink", "red"];

export function InsightsDashboard({
  snapshot,
  providerScope,
  refreshing,
  notice,
  onProviderScopeChange,
  onRefresh
}: InsightsDashboardProps): React.JSX.Element {
  const insights = useMemo(
    () => buildUsageInsights(snapshot, providerScope),
    [snapshot, providerScope]
  );

  return (
    <div className="atlas-page atlas-insights-page">
      <div className="atlas-toolbar">
        <div className="atlas-toolbar-cluster">
          <span className="atlas-insights-range">
            <HistoryIcon aria-hidden="true" />
            All collected history
          </span>
        </div>
        <div className="atlas-toolbar-actions">
          <ProviderScopeSelect
            onChange={onProviderScopeChange}
            providers={snapshot.providers.filter((provider) => provider.enabled)}
            value={providerScope}
          />
          <Tooltip>
            <Button
              aria-label="Refresh insights"
              className="atlas-toolbar-icon"
              isIconOnly
              isPending={refreshing}
              onPress={() => void onRefresh()}
              variant="secondary"
            >
              <RefreshIcon />
            </Button>
            <Tooltip.Content>Refresh insights</Tooltip.Content>
          </Tooltip>
        </div>
      </div>

      {notice ? <AnalyzerNotice {...notice} /> : null}

      <header className="atlas-page-header">
        <p className="atlas-kicker">Insights</p>
        <h1 className="atlas-page-title">Your AI rhythm</h1>
        <p className="atlas-hero-description">
          A local view of when you use AI, which models you reach for, and how your week takes shape.
        </p>
      </header>

      <section aria-label="Usage profile" className="atlas-insights-summary">
        <RhythmCard insights={insights} />
        <TopModelCard model={insights.topModel} />
        <BusiestDayCard insights={insights} />
      </section>

      <section aria-labelledby="typical-week-heading" className="atlas-section">
        <div className="atlas-section-heading">
          <div>
            <p className="atlas-kicker">Time of day</p>
            <h2 id="typical-week-heading">Your typical week</h2>
          </div>
          <p>Two-hour blocks in local time, normalized to your busiest block.</p>
        </div>
        <Card className="atlas-week-heatmap-card" variant="transparent">
          <Card.Content>
            <WeekHeatmap insights={insights} />
          </Card.Content>
        </Card>
      </section>

      <section className="atlas-section atlas-content-grid" aria-label="Usage mix">
        <h2 className="sr-only">Usage mix</h2>
        <ModelMix insights={insights} />
        <WeekdayBalance insights={insights} />
      </section>

      <p className="atlas-footnote">
        Insights use all collected history for the selected provider. Hourly activity is shown in local time;
        model totals reflect each provider&apos;s available model metadata.
      </p>
    </div>
  );
}

function RhythmCard({ insights }: { insights: UsageInsights }): React.JSX.Element {
  const persona = insights.persona;
  const PersonaIcon = persona && (persona.kind === "night" || persona.kind === "evening") ? MoonIcon : SunIcon;

  return (
    <Card className="atlas-rhythm-card" variant="transparent">
      <Card.Content>
        <div className="atlas-rhythm-card__lead">
          <span aria-hidden="true" className="atlas-rhythm-card__icon"><PersonaIcon /></span>
          <div>
            <p className="atlas-kicker">Workstyle signal</p>
            <h2>{persona?.label ?? "Your rhythm is still forming"}</h2>
            <p>
              {persona?.description
                ?? "Hourly history is needed before UsageAtlas can identify your strongest work window."}
            </p>
          </div>
        </div>

        {persona ? (
          <>
            <div className="atlas-rhythm-signals">
              <Signal label="Peak hour" value={formatHour(insights.peakHour)} />
              <Signal label="Dominant window" value={`${persona.share}%`} />
              <Signal label="Recorded" value={formatActiveHours(insights.activeHours)} />
            </div>
            <div aria-label="Usage by time of day" className="atlas-daypart-bars">
              {insights.dayparts.map((daypart, index) => (
                <div className="atlas-daypart-row" key={daypart.id}>
                  <div className="atlas-daypart-row__copy">
                    <span>{daypart.label}</span>
                    <span title={formatExactTokens(daypart.totalTokens)}>{daypart.share}%</span>
                  </div>
                  <div
                    aria-label={`${daypart.label}, ${daypart.rangeLabel}: ${daypart.share}% of hourly token volume`}
                    className="atlas-daypart-track"
                    role="img"
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        backgroundColor: ditherColor(chartPalette[index % chartPalette.length] ?? "grey"),
                        width: `${daypart.share}%`
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <InsightEmpty>
            Connect a provider that reports hourly session history to see your workstyle.
          </InsightEmpty>
        )}
      </Card.Content>
    </Card>
  );
}

function Signal({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TopModelCard({ model }: { model: ModelInsight | null }): React.JSX.Element {
  return (
    <Card className="atlas-insight-spotlight" variant="transparent">
      <Card.Content>
        <span aria-hidden="true" className="atlas-insight-spotlight__icon"><ProvidersIcon /></span>
        <p className="atlas-kicker">Top model</p>
        {model ? (
          <>
            <h2 title={model.label}>{model.label}</h2>
            <strong className="atlas-insight-spotlight__value">{model.share}%</strong>
            <p>{formatTokens(model.totalTokens)} across {formatProviderCount(model.providerNames.length)}</p>
          </>
        ) : (
          <>
            <h2>No model totals yet</h2>
            <p>Model share appears when a connected provider includes model metadata.</p>
          </>
        )}
      </Card.Content>
    </Card>
  );
}

function BusiestDayCard({ insights }: { insights: UsageInsights }): React.JSX.Element {
  const day = insights.busiestWeekday;
  return (
    <Card className="atlas-insight-spotlight" variant="transparent">
      <Card.Content>
        <span aria-hidden="true" className="atlas-insight-spotlight__icon"><DayIcon /></span>
        <p className="atlas-kicker">Busiest weekday</p>
        {day ? (
          <>
            <h2>{day.label}</h2>
            <strong className="atlas-insight-spotlight__value">{day.share}%</strong>
            <p>{formatTokens(day.totalTokens)} of your collected weekday activity</p>
          </>
        ) : (
          <>
            <h2>No daily pattern yet</h2>
            <p>Daily history is needed before a busiest weekday can be identified.</p>
          </>
        )}
      </Card.Content>
    </Card>
  );
}

function WeekHeatmap({ insights }: { insights: UsageInsights }): React.JSX.Element {
  const [activeCellIndex, setActiveCellIndex] = useState(0);

  if (!insights.hourlyHistoryAvailable || insights.totalHourlyTokens <= 0) {
    return (
      <InsightEmpty>
        No hourly activity is available yet. This map fills in as providers report time-of-day history.
      </InsightEmpty>
    );
  }
  const columns = insights.weekdays[0]?.hourBlocks ?? [];
  const peakTokens = Math.max(
    0,
    ...insights.weekdays.flatMap((weekday) => weekday.hourBlocks.map((block) => block.totalTokens))
  );

  return (
    <div className="atlas-week-heatmap">
      <table>
        <caption className="sr-only">AI token activity by weekday and two-hour block</caption>
        <thead>
          <tr>
            <th aria-label="Weekday" />
            {columns.map((block) => (
              <th key={block.hour} scope="col">
                <span aria-hidden="true">{block.hour % 6 === 0 ? formatCompactHour(block.hour) : ""}</span>
                <span className="sr-only">{block.label}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {insights.weekdays.map((weekday) => (
            <tr key={weekday.label}>
              <th scope="row"><span aria-hidden="true">{weekday.shortLabel}</span><span className="sr-only">{weekday.label}</span></th>
              {weekday.hourBlocks.map((block, blockIndex) => {
                const cellIndex = weekday.index * columns.length + blockIndex;
                return (
                  <td key={block.hour}>
                    <HeatmapCell
                      active={activeCellIndex === cellIndex}
                      block={block}
                      cellIndex={cellIndex}
                      columnCount={columns.length}
                      onActivate={setActiveCellIndex}
                      peakTokens={peakTokens}
                      totalCells={insights.weekdays.length * columns.length}
                      weekday={weekday}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div aria-hidden="true" className="atlas-heatmap-legend">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((level) => <i data-level={level} key={level} />)}
        <span>More</span>
      </div>
      <p className="atlas-heatmap-note">{formatCoverage(insights)}</p>
    </div>
  );
}

function HeatmapCell({
  active,
  block,
  cellIndex,
  columnCount,
  onActivate,
  peakTokens,
  totalCells,
  weekday
}: {
  active: boolean;
  block: HourBlockInsight;
  cellIndex: number;
  columnCount: number;
  onActivate(index: number): void;
  peakTokens: number;
  totalCells: number;
  weekday: WeekdayInsight;
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [detailsReady, setDetailsReady] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const frameRef = useRef<number | null>(null);
  const cellLabel = `${weekday.label}, ${block.label}: ${formatTokens(block.totalTokens)}`;
  const relativeActivity = peakTokens > 0
    ? `${Math.round((block.totalTokens / peakTokens) * 100)}% of busiest block`
    : "No recorded activity";

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    let nextIndex: number;
    if (event.key === "ArrowLeft") nextIndex = Math.max(0, cellIndex - 1);
    else if (event.key === "ArrowRight") nextIndex = Math.min(totalCells - 1, cellIndex + 1);
    else if (event.key === "ArrowUp") nextIndex = Math.max(0, cellIndex - columnCount);
    else if (event.key === "ArrowDown") nextIndex = Math.min(totalCells - 1, cellIndex + columnCount);
    else if (event.key === "Home") nextIndex = cellIndex - (cellIndex % columnCount);
    else if (event.key === "End") nextIndex = Math.min(totalCells - 1, cellIndex + columnCount - 1 - (cellIndex % columnCount));
    else return;

    event.preventDefault();
    onActivate(nextIndex);
    document.getElementById(`heatmap-cell-${nextIndex}`)?.focus();
  }

  function handleOpenChange(nextOpen: boolean): void {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    setIsOpen(nextOpen);
    setDetailsReady(false);

    if (nextOpen) {
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = requestAnimationFrame(() => {
          setDetailsReady(true);
          frameRef.current = null;
        });
      });
    }
  }

  return (
    <Tooltip
      closeDelay={0}
      delay={0}
      isOpen={isOpen}
      onOpenChange={handleOpenChange}
    >
      <button
        aria-label={cellLabel}
        className="atlas-week-heatmap__cell"
        data-level={block.intensity}
        id={`heatmap-cell-${cellIndex}`}
        onFocus={(event) => {
          onActivate(cellIndex);
          setKeyboardOpen(!event.currentTarget.matches(":hover"));
        }}
        onKeyDown={handleKeyDown}
        onPointerEnter={() => setKeyboardOpen(false)}
        tabIndex={active ? 0 : -1}
        type="button"
      />
      <Tooltip.Content className="atlas-heatmap-tooltip" data-keyboard={keyboardOpen} offset={8} placement="top">
        <div className="atlas-heatmap-tooltip__heading">
          <strong>{weekday.label}</strong>
          <span>{block.label}</span>
        </div>
        <div className="atlas-heatmap-tooltip__details" data-ready={detailsReady}>
          <dl aria-hidden={!detailsReady} className="atlas-heatmap-tooltip__data">
            <div><dt>Collected tokens</dt><dd>{formatTokens(block.totalTokens)}</dd></div>
            <div><dt>Relative activity</dt><dd>{relativeActivity}</dd></div>
          </dl>
          <div
            aria-label="Loading heatmap details"
            aria-hidden={detailsReady}
            className="atlas-heatmap-tooltip__skeleton"
            role="status"
          >
            <Skeleton className="h-3 w-full rounded-sm" />
            <Skeleton className="h-3 w-4/5 rounded-sm" />
          </div>
        </div>
      </Tooltip.Content>
    </Tooltip>
  );
}

function ModelMix({ insights }: { insights: UsageInsights }): React.JSX.Element {
  const data = insights.models.map((model, index) => ({
    color: chartPalette[index % chartPalette.length] ?? "grey",
    id: model.id,
    name: model.label,
    value: model.totalTokens
  }));
  const config = Object.fromEntries(
    data.map((row) => [row.name, { color: row.color, label: row.name }])
  ) as ChartConfig;

  return (
    <Card className="min-w-0" variant="transparent">
      <Card.Header>
        <div>
          <Card.Title>Model mix</Card.Title>
          <Card.Description>Share of tokens across reported models</Card.Description>
        </div>
      </Card.Header>
      <Card.Content>
        {data.length === 0 ? (
          <InsightEmpty>Model share appears when connected providers include model metadata.</InsightEmpty>
        ) : (
          <div className="atlas-model-mix">
            <div className="atlas-model-donut">
              <div className="h-[184px] w-[184px]">
                <PieChart
                  bloom="low"
                  config={config}
                  data={data}
                  dataKey="value"
                  innerRadius={0.68}
                  margins={{ bottom: 8, left: 8, right: 8, top: 8 }}
                  nameKey="name"
                >
                  <Pie variant="gradient" />
                  <ChartTooltip valueFormatter={(value) => formatTokens(value)} variant="frosted-glass" />
                </PieChart>
              </div>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <strong className="atlas-donut-value tabular-nums" title={formatExactTokens(insights.totalModelTokens)}>
                  {formatCompactNumber(insights.totalModelTokens)}
                </strong>
                <span className="text-xs text-muted">tokens</span>
              </div>
            </div>
            <div className="atlas-model-legend">
              {insights.models.map((model, index) => (
                <div className="atlas-model-row" key={`${model.id}-${model.label}`}>
                  <span
                    aria-hidden="true"
                    className="atlas-model-row__swatch"
                    style={{ backgroundColor: ditherColor(chartPalette[index % chartPalette.length] ?? "grey") }}
                  />
                  <div>
                    <strong title={model.label}>{model.label}</strong>
                    <span>{model.providerNames.join(", ")}</span>
                  </div>
                  <span className="atlas-model-row__value" title={formatExactTokens(model.totalTokens)}>
                    <strong>{model.share}%</strong>
                    <span>{formatCompactNumber(model.totalTokens)}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

function WeekdayBalance({ insights }: { insights: UsageInsights }): React.JSX.Element {
  const peak = Math.max(0, ...insights.weekdays.map((day) => day.totalTokens));

  return (
    <Card className="min-w-0" variant="transparent">
      <Card.Header>
        <div>
          <Card.Title>Weekday balance</Card.Title>
          <Card.Description>Bars are normalized to your busiest weekday</Card.Description>
        </div>
      </Card.Header>
      <Card.Content>
        {peak <= 0 ? (
          <InsightEmpty>Daily history is needed before weekday balance can be calculated.</InsightEmpty>
        ) : (
          <ol className="atlas-weekday-bars">
            {insights.weekdays.map((day) => (
              <li key={day.label}>
                <div className="atlas-weekday-bars__copy">
                  <span>{day.label}</span>
                  <span title={formatExactTokens(day.totalTokens)}>{day.share}%</span>
                </div>
                <div
                  aria-label={`${day.label}: ${day.share}% of weekly token volume`}
                  className="atlas-weekday-bars__track"
                  role="img"
                >
                  <span aria-hidden="true" style={{ width: `${Math.round((day.totalTokens / peak) * 100)}%` }} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card.Content>
    </Card>
  );
}

function InsightEmpty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="atlas-insight-empty">{children}</p>;
}

function formatHour(hour: number | null): string {
  if (hour === null) return "Not available";
  return formatHourOfDay(hour);
}

function formatCompactHour(hour: number): string {
  return formatHourOfDay(hour);
}

function formatActiveHours(hours: number): string {
  return `${hours} active ${hours === 1 ? "hour" : "hours"}`;
}

function formatProviderCount(count: number): string {
  return `${count} ${count === 1 ? "provider" : "providers"}`;
}

function formatCoverage(insights: UsageInsights): string {
  if (!insights.coverageStart || !insights.coverageEnd) return "No collected coverage";
  return `${insights.coverageDays} ${insights.coverageDays === 1 ? "day" : "days"} of coverage · ${shortDay(insights.coverageStart)}–${shortDay(insights.coverageEnd)}`;
}

function shortDay(day: string): string {
  return shortDayFormatter.format(new Date(`${day}T12:00:00`));
}

function ditherColor(color: DitherColor): string {
  return rgb(seedOfColor(color).fill);
}

const shortDayFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
