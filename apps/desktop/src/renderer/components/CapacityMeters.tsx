import type { DashboardProvider } from "@usageatlas/contracts";
import { Button, Card } from "@heroui/react";
import { useId } from "react";
import "../capacity-meters.css";
import { limitEntryKey, rankedLimitEntries, type LimitEntry } from "../../shared/capacity-model";
import { formatReset } from "../dashboard-model";
import { ChevronRightIcon } from "../icons";
import { ProviderLogo } from "./ProviderLogo";

interface LimitsPreviewCardProps {
  providers: DashboardProvider[];
  limitOrder: string[];
  onOpenAll(): void;
}

export function LimitsPreviewCard({ providers, limitOrder, onOpenAll }: LimitsPreviewCardProps): React.JSX.Element {
  const entries = rankedLimitEntries(providers, limitOrder);
  const visibleEntries = entries.slice(0, 4);
  const hiddenCount = Math.max(0, entries.length - visibleEntries.length);

  return (
    <Card className="atlas-limits-preview" variant="transparent">
      <Card.Content className="atlas-limits-preview__content">
        <div className="atlas-limits-preview__heading">
          <div>
            <p className="atlas-kicker">Available limits</p>
            <h2>Active tool capacity</h2>
          </div>
          {entries.length > 0 ? (
            <Button
              className="atlas-limits-preview__action"
              onPress={onOpenAll}
              size="sm"
              variant="tertiary"
            >
              <span>{hiddenCount > 0 ? `Show more · +${hiddenCount}` : "View all"}</span>
              <ChevronRightIcon />
            </Button>
          ) : null}
        </div>

        {visibleEntries.length > 0 ? (
          <div
            className="atlas-limits-preview__meters"
            data-count={String(visibleEntries.length)}
          >
            {visibleEntries.map((entry) => (
              <LimitMeter compact entry={entry} key={limitEntryKey(entry)} />
            ))}
          </div>
        ) : (
          <LimitMeterEmpty />
        )}
      </Card.Content>
    </Card>
  );
}

export function LimitMeter({
  entry,
  compact = false,
  showHeader = true,
  showReset = false
}: {
  entry: LimitEntry;
  compact?: boolean;
  showHeader?: boolean;
  showReset?: boolean;
}): React.JSX.Element {
  const remaining = clampPercent(entry.window.remainingPercent);
  const used = clampPercent(entry.window.usedPercent);
  const needleAngle = -90 + remaining * 1.8;
  const gradientID = `limit-gradient-${useId().replaceAll(":", "")}`;
  const reset = formatReset(entry.window);
  const accessibleLabel = `${entry.provider.name} ${entry.window.label} limit: ${Math.round(remaining)}% available, ${Math.round(used)}% used. ${reset}.`;

  return (
    <figure
      aria-label={accessibleLabel}
      className="atlas-limit-meter"
      data-compact={compact ? "true" : "false"}
      role="img"
    >
      {showHeader ? (
        <figcaption className="atlas-limit-meter__header">
          <ProviderLogo mini providerID={entry.provider.id} providerName={entry.provider.name} />
          <div className="atlas-limit-meter__label">
            <span>{entry.window.label}</span>
            {showReset ? <small>{reset}</small> : null}
          </div>
        </figcaption>
      ) : null}

      <div aria-hidden="true" className="atlas-limit-meter__dial">
        <svg viewBox="0 0 180 132">
          <defs>
            <linearGradient
              gradientUnits="userSpaceOnUse"
              id={gradientID}
              x1="20"
              x2="160"
              y1="90"
              y2="90"
            >
              <stop offset="0%" stopColor="var(--atlas-limit-danger)" />
              <stop offset="24%" stopColor="var(--atlas-limit-hot)" />
              <stop offset="52%" stopColor="var(--atlas-limit-green)" />
              <stop offset="76%" stopColor="var(--atlas-limit-cyan)" />
              <stop offset="100%" stopColor="var(--atlas-limit-blue)" />
            </linearGradient>
          </defs>
          <path className="atlas-limit-meter__track" d="M 20 90 A 70 70 0 0 1 160 90" />
          <path
            className="atlas-limit-meter__spectrum"
            d="M 20 90 A 70 70 0 0 1 160 90"
            stroke={`url(#${gradientID})`}
          />
          <g className="atlas-limit-meter__ticks">
            {meterTicks.map((angle) => (
              <line
                key={angle}
                x1="90"
                x2="90"
                y1="23"
                y2={angle % 45 === 0 ? "31" : "28"}
                transform={`rotate(${angle} 90 90)`}
              />
            ))}
          </g>
          <g
            className="atlas-limit-meter__needle"
            style={{ transform: `rotate(${needleAngle}deg)` }}
          >
            <path d="M 87.5 90 L 90 33 L 92.5 90 Z" />
          </g>
          <g
            className="atlas-limit-meter__needle-value"
            transform="translate(90 113)"
          >
            <text dominantBaseline="central" textAnchor="middle" y="0.5">
              {Math.round(remaining)}%
            </text>
          </g>
          <circle className="atlas-limit-meter__hub-outer" cx="90" cy="90" r="8" />
          <circle className="atlas-limit-meter__hub-inner" cx="90" cy="90" r="3.5" />
          <text className="atlas-limit-meter__edge-label" x="11" y="128">0%</text>
          <text className="atlas-limit-meter__edge-label" textAnchor="end" x="169" y="128">100%</text>
        </svg>
      </div>
    </figure>
  );
}

function LimitMeterEmpty(): React.JSX.Element {
  return (
    <div className="atlas-limits-preview__empty">
      <div aria-hidden="true" className="atlas-limits-preview__empty-dial">
        <span />
      </div>
      <div>
        <strong>No live limits</strong>
        <p>Active tools are not reporting metered capacity yet.</p>
      </div>
    </div>
  );
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

const meterTicks = [-90, -67.5, -45, -22.5, 0, 22.5, 45, 67.5, 90];
