import { Card } from "@heroui/react";
import type { ActivityGranularity, ActivitySeries, UsageActivityBucket } from "../activity-buckets";
import { formatCompactCurrency, formatCompactNumber, formatCost, formatExactTokens, formatTokens } from "../number-format";
import type { ProviderPeriodUsage, TokenComposition } from "../personal-analytics";
import type { ModelInsight, ModelMix, ModelProviderUsage } from "../usage-insights";
import { Area, Line } from "./dither-kit/area";
import { AreaChart, LineChart } from "./dither-kit/area-chart";
import { Bar } from "./dither-kit/bar";
import { BarChart } from "./dither-kit/bar-chart";
import type { ChartConfig } from "./dither-kit/chart-context";
import { Grid } from "./dither-kit/grid";
import { type DitherColor, rgb, seedOfColor } from "./dither-kit/palette";
import { Pie } from "./dither-kit/pie";
import { PieChart } from "./dither-kit/pie-chart";
import { Radar } from "./dither-kit/radar";
import { RadarChart } from "./dither-kit/radar-chart";
import { Sparkline } from "./dither-kit/sparkline";
import { Tooltip } from "./dither-kit/tooltip";
import { XAxis } from "./dither-kit/x-axis";
import { YAxis } from "./dither-kit/y-axis";
import { ProviderLogo } from "./ProviderLogo";
import { KPI, TrendChip } from "./UsagePrimitives";

const chartPalette: DitherColor[] = ["green", "blue", "purple", "orange", "pink", "red"];

const activityConfig = {
  tokens: { color: "green", label: "Tokens" }
} satisfies ChartConfig;

const tokenMixConfig = {
  freshInput: { color: chartPalette[0], label: "Fresh input" },
  cacheRead: { color: chartPalette[1], label: "Cache read" },
  cacheCreated: { color: chartPalette[2], label: "Cache created" },
  output: { color: chartPalette[3], label: "Output" }
} satisfies ChartConfig;

const activityCopy: Record<ActivityGranularity, { title: string; description: string }> = {
  hour: { title: "Hourly activity", description: "Each bar shows the token total for one local hour" },
  "four-hour": { title: "4-hour activity", description: "Each bar shows the token total for a four-hour batch" },
  day: { title: "Daily activity", description: "Each bar shows the token total for one day" },
  "multi-day": { title: "Period activity", description: "Each bar shows the token total for an adaptive date batch" }
};

export function SeriesChart({
  buckets,
  kind,
  title,
  unavailableReason
}: {
  buckets: UsageActivityBucket[];
  kind: "tokens" | "cost" | "requests";
  title: string;
  unavailableReason?: string | null;
}): React.JSX.Element {
  const data = buckets.map((bucket) => ({
    axisLabel: bucket.axisLabel,
    label: bucket.label,
    value: kind === "tokens" ? bucket.totalTokens : kind === "requests" ? bucket.requests : bucket.estimatedCostUSD ?? 0
  }));
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const color: DitherColor = kind === "tokens" ? "green" : kind === "cost" ? "purple" : "blue";
  const config = { value: { color, label: title } } satisfies ChartConfig;

  return (
    <Card className="min-w-0" variant="transparent">
      <Card.Header className="flex-row items-start justify-between gap-4">
        <div>
          <Card.Title>{title}</Card.Title>
          <Card.Description>{buckets.length ? `${shortDay(buckets[0]?.startDay ?? "")} – ${shortDay(buckets.at(-1)?.endDay ?? "")}` : "No range"}</Card.Description>
        </div>
        <strong className="text-lg font-semibold tabular-nums">
          {unavailableReason ? "—" : formatChartSummaryValue(total, kind)}
        </strong>
      </Card.Header>
      <Card.Content className="mt-4">
        {unavailableReason ? (
          <p className="grid h-56 place-items-center px-6 text-center text-sm text-muted">{unavailableReason}</p>
        ) : buckets.length === 0 || buckets.every((bucket) => !bucket.covered) ? (
          <p className="grid h-56 place-items-center text-sm text-muted">No collected activity in this range</p>
        ) : (
          <div className="h-60">
            {kind === "tokens" ? (
              <AreaChart bloom="low" config={config} data={data}>
                <Grid />
                <XAxis dataKey="axisLabel" />
                <YAxis tickFormatter={(value) => formatAxisValue(value, kind)} />
                <Area dataKey="value" variant="gradient" />
                <Tooltip labelKey="label" valueFormatter={(value) => formatSeriesValue(value, kind)} variant="frosted-glass" />
              </AreaChart>
            ) : (
              <LineChart bloom="low" config={config} data={data}>
                <Grid />
                <XAxis dataKey="axisLabel" />
                <YAxis tickFormatter={(value) => formatAxisValue(value, kind)} />
                <Line dataKey="value" variant="gradient" />
                <Tooltip labelKey="label" valueFormatter={(value) => formatSeriesValue(value, kind)} variant="frosted-glass" />
              </LineChart>
            )}
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

export function ActivityComposedChart({ series }: { series: ActivitySeries }): React.JSX.Element {
  const data = series.buckets.map((bucket) => ({
    axisLabel: bucket.axisLabel,
    label: bucket.label,
    tokens: bucket.totalTokens
  }));
  const hasCoverage = series.buckets.some((bucket) => bucket.covered);
  const copy = activityCopy[series.granularity];

  return (
    <Card className="min-w-0" variant="transparent">
      <Card.Header className="flex-row items-start justify-between gap-4">
        <div>
          <Card.Title>{copy.title}</Card.Title>
          <Card.Description>{copy.description}</Card.Description>
        </div>
        <div className="flex flex-wrap justify-end gap-3 text-xs text-muted">
          <ChartLegend color={ditherColor("green")} label="Tokens" />
        </div>
      </Card.Header>
      <Card.Content className="mt-4">
        {!hasCoverage ? (
          <p className="grid h-64 place-items-center text-sm text-muted">No collected activity in this range</p>
        ) : (
          <div className="h-70">
            <BarChart bloom="low" config={activityConfig} data={data} margins={{ left: 52 }}>
              <Grid />
              <XAxis dataKey="axisLabel" />
              <YAxis tickFormatter={formatCompactNumber} />
              <Bar dataKey="tokens" variant="gradient" />
              <Tooltip
                labelKey="label"
                valueFormatter={(value) => formatTokens(value)}
                variant="frosted-glass"
              />
            </BarChart>
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

export function ProviderDonut({ rows }: { rows: ProviderPeriodUsage[] }): React.JSX.Element {
  const data = rows
    .filter((row) => row.totals.totalTokens > 0)
    .map((row, index) => ({
      color: chartPalette[index % chartPalette.length],
      id: row.id,
      name: row.name,
      value: row.totals.totalTokens
    }));
  const total = data.reduce((sum, row) => sum + row.value, 0);
  const config = Object.fromEntries(
    data.map((row) => [row.name, { color: row.color, label: row.name }])
  ) as ChartConfig;

  if (!data.length) return <p className="grid min-h-52 place-items-center text-sm text-muted">No provider activity</p>;

  return (
    <div className="atlas-provider-mix">
      <div className="atlas-provider-donut">
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
            <Tooltip valueFormatter={(value) => formatTokens(value)} variant="frosted-glass" />
          </PieChart>
        </div>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <strong className="atlas-donut-value tabular-nums" title={formatExactTokens(total)}>{formatCompactNumber(total)}</strong>
          <span className="text-xs text-muted">tokens</span>
        </div>
      </div>
      <div className="atlas-provider-legend">
        {data.map((row) => (
          <div className="atlas-provider-row" key={row.id}>
            <ProviderLogo compact providerID={row.id} providerName={row.name} />
            <div className="atlas-provider-copy">
              <p className="atlas-provider-name"><span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: ditherColor(row.color) }} />{row.name}</p>
              <p className="text-xs text-muted">{Math.round((row.value / total) * 100)}% of load</p>
            </div>
            <div className="atlas-provider-value" title={formatExactTokens(row.value)}>
              <strong>{formatCompactNumber(row.value)}</strong>
              <span>tokens</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TokenMixChart({
  composition,
  providers
}: {
  composition: TokenComposition;
  providers: ProviderPeriodUsage[];
}): React.JSX.Element {
  const rows = [
    { color: chartPalette[0], key: "freshInput", label: "Fresh input", value: composition.freshInput },
    { color: chartPalette[1], key: "cacheRead", label: "Cache read", value: composition.cacheRead },
    { color: chartPalette[2], key: "cacheCreated", label: "Cache created", value: composition.cacheCreated },
    { color: chartPalette[3], key: "output", label: "Output", value: composition.output }
  ];
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  // Cache reads dwarf every other category, so the mix is drawn as a share of each
  // tool's own column: the small categories stay visible and the tools stay comparable.
  const chartData = providers
    .filter((provider) => provider.totals.totalTokens > 0)
    .map((provider) => ({
      cacheCreated: provider.totals.cacheCreationInputTokens,
      cacheRead: provider.totals.cachedInputTokens,
      freshInput: provider.totals.inputTokens,
      output: provider.totals.outputTokens,
      provider: provider.name
    }));

  return (
    <div className="atlas-token-mix grid gap-5">
      {total > 0 && chartData.length > 0 ? (
        <div aria-label="Token mix by share" className="h-55" role="img">
          <BarChart
            bloom="low"
            config={tokenMixConfig}
            data={chartData}
            margins={{ bottom: 24, left: 42, right: 12, top: 10 }}
            stackType="percent"
          >
            <Grid />
            <XAxis dataKey="provider" />
            <YAxis tickFormatter={(value) => `${Math.round(value * 100)}%`} />
            {rows.map((row) => <Bar dataKey={row.key} key={row.key} variant="gradient" />)}
            <Tooltip
              labelKey="provider"
              valueFormatter={(value) => formatTokens(value)}
              variant="frosted-glass"
            />
          </BarChart>
        </div>
      ) : (
        <p className="grid h-60 place-items-center rounded-2xl bg-surface-secondary text-sm text-muted">No token activity</p>
      )}
      <div className="atlas-token-legend">
        {rows.map((row) => (
          <div className="atlas-token-row" key={row.key}>
            <span className="size-2.5 rounded-full" style={{ backgroundColor: ditherColor(row.color) }} />
            <div className="atlas-token-copy">
              <div className="atlas-token-topline">
                <p>{row.label}</p>
                <strong className="tabular-nums" title={formatExactTokens(row.value)}>{formatCompactNumber(row.value)}</strong>
              </div>
              <p className="text-xs text-muted">{total > 0 ? `${Math.round((row.value / total) * 100)}% of tokens` : "No activity"}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Which models the tools reached for, as one radar spoke per model and one series per
 * tool. Every spoke is that tool's share of its own tokens over the same days, so a
 * quiet tool keeps a readable shape beside a busy one.
 */
export function ModelMixCard({
  description,
  emptyMessage,
  mix
}: {
  description: string;
  emptyMessage: string;
  mix: ModelMix;
}): React.JSX.Element {
  const providerColors = new Map<string, DitherColor>(
    mix.modelProviders.map((provider, index) => [
      provider.name,
      chartPalette[index % chartPalette.length] ?? "grey"
    ])
  );
  // "Other models" is a bucket, not a model, so it stays out of the spokes.
  const spokes = mix.models.filter((model) => model.id !== "other");
  // A tool whose models all landed in that bucket would draw a dot at the centre.
  const series = mix.modelProviders.filter((provider) =>
    spokes.some((model) => modelProviderRow(model, provider.name)?.totalTokens)
  );
  const config = Object.fromEntries(
    series.map((provider) => [
      provider.name,
      { color: providerColors.get(provider.name) ?? "grey", label: provider.name }
    ])
  ) as ChartConfig;
  const radarData = spokes.map((model) => ({
    model: shortModelLabel(model.label),
    ...Object.fromEntries(series.map((provider) => [
      provider.name,
      modelProviderRow(model, provider.name)?.share ?? 0
    ]))
  }));
  // Three spokes is the least that still draws an area rather than a line.
  const chartable = spokes.length >= 3 && series.length > 0;

  return (
    <Card className="min-w-0" variant="transparent">
      <Card.Header className="flex-row items-start justify-between gap-4">
        <div>
          <Card.Title>Model mix</Card.Title>
          <Card.Description>{description}</Card.Description>
        </div>
        <strong className="text-lg font-semibold tabular-nums" title={formatExactTokens(mix.totalModelTokens)}>
          {formatCompactNumber(mix.totalModelTokens)}
        </strong>
      </Card.Header>
      <Card.Content>
        {mix.models.length === 0 ? (
          <p className="atlas-insight-empty">{emptyMessage}</p>
        ) : (
          <div className="atlas-model-mix">
            {chartable ? (
              <div aria-label="Model share by tool" className="atlas-model-radar" role="img">
                <RadarChart
                  bloom="low"
                  config={config}
                  data={radarData}
                  margins={{ bottom: 26, left: 68, right: 68, top: 26 }}
                  nameKey="model"
                >
                  {series.map((provider) => (
                    <Radar dataKey={provider.name} key={provider.name} variant="gradient" />
                  ))}
                  <Tooltip
                    valueFormatter={(value, name, index) => {
                      const model = spokes[index];
                      const tokens = model ? modelProviderRow(model, name)?.totalTokens ?? 0 : 0;
                      return `${Math.round(value)}% · ${formatTokens(tokens)}`;
                    }}
                    variant="frosted-glass"
                  />
                </RadarChart>
              </div>
            ) : null}
            <div className="atlas-model-legend">
              {chartable ? (
                <div className="atlas-model-series">
                  {series.map((provider) => (
                    <span className="atlas-model-series__chip" key={provider.name}>
                      <i
                        aria-hidden="true"
                        style={{ backgroundColor: ditherColor(providerColors.get(provider.name) ?? "grey") }}
                      />
                      {provider.name}
                    </span>
                  ))}
                </div>
              ) : null}
              {mix.models.map((model) => (
                <div className="atlas-model-row" key={`${model.id}-${model.label}`}>
                  <span
                    aria-hidden="true"
                    className="atlas-model-row__swatch"
                    style={{
                      backgroundColor: ditherColor(providerColors.get(model.providers[0]?.name ?? "") ?? "grey")
                    }}
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

function modelProviderRow(model: ModelInsight, providerName: string): ModelProviderUsage | undefined {
  return model.providers.find((row) => row.name === providerName);
}

/** Radar spokes get ~10px of mono type, so a model keeps only its distinctive part. */
function shortModelLabel(label: string): string {
  const trimmed = (label.split("/").at(-1) ?? label)
    .replace(/-\d{8}$/u, "")
    .replace(/^(anthropic|openai|google|meta|mistral|x-ai|deepseek|qwen)[.-]/iu, "");
  return trimmed.length > 16 ? `${trimmed.slice(0, 15)}…` : trimmed;
}

export function StatTile({
  label,
  value,
  detail,
  series,
  trend
}: {
  label: string;
  value: string;
  detail: string;
  series?: number[];
  trend?: number | null;
}): React.JSX.Element {
  const hasSeries = (series?.length ?? 0) > 1;
  const hasTrend = trend !== undefined;
  const trendValue = trend ?? 0;
  const trendDirection = trend === undefined || trend === null || trend === 0 ? "neutral" : trend > 0 ? "up" : "down";
  const sparklineColor: DitherColor = trend === undefined || trend === null || trend === 0
    ? "grey"
    : trend > 0 ? "green" : "red";

  return (
    <KPI className="atlas-stat">
      <KPI.Header><KPI.Title>{label}</KPI.Title></KPI.Header>
      <KPI.Content className={hasSeries ? "grid grid-cols-[minmax(0,1fr)_minmax(72px,0.8fr)] items-end gap-3" : "flex flex-col items-start gap-2"}>
        <div className="min-w-0">
          <strong className="block truncate text-2xl leading-none font-semibold tracking-tight tabular-nums">{value}</strong>
          {hasTrend ? (
            <TrendChip className="mt-2" trend={trendDirection} variant="tertiary">
              {trend === null ? "No prior" : `${trendValue > 0 ? "+" : ""}${trendValue}%`}
              {trend === null ? null : <TrendChip.Suffix>vs prior</TrendChip.Suffix>}
            </TrendChip>
          ) : (
            <span className="mt-2 block text-xs text-muted">{detail}</span>
          )}
        </div>
        {hasSeries ? (
          <div aria-hidden="true" className="h-[52px] min-w-0 self-end">
            <Sparkline bloom="low" color={sparklineColor} data={series ?? []} variant="gradient" />
          </div>
        ) : null}
      </KPI.Content>
    </KPI>
  );
}

function ChartLegend({ color, label }: { color: string; label: string }): React.JSX.Element {
  return <span className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ backgroundColor: color }} />{label}</span>;
}

function ditherColor(color: DitherColor): string {
  return rgb(seedOfColor(color).fill);
}

function formatSeriesValue(value: number, kind: "tokens" | "cost" | "requests"): string {
  if (kind === "cost") return formatCost(value);
  return kind === "tokens" ? formatTokens(value) : formatCompactNumber(value);
}

function formatChartSummaryValue(value: number, kind: "tokens" | "cost" | "requests"): string {
  if (kind === "cost") return formatCompactCurrency(value);
  return formatSeriesValue(value, kind);
}

function formatAxisValue(value: number, kind: "tokens" | "cost" | "requests"): string {
  return kind === "cost" ? formatCompactCurrency(value) : formatCompactNumber(value);
}

function shortDay(value: string): string {
  return value ? shortDayFormatter.format(new Date(`${value}T12:00:00`)) : "";
}

const shortDayFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
