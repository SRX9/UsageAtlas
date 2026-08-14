import type { DashboardProvider, DashboardSnapshot } from "@usageatlas/contracts";
import { Button, Switch } from "@heroui/react";
import { Reorder, useDragControls } from "motion/react";
import { useState } from "react";
import {
  limitEntries,
  limitEntryKey,
  mergeLimitOrder,
  rankedLimitEntries,
  showsInTray,
  type LimitEntry,
  type TrayLimitPreferences
} from "../../shared/capacity-model";
import { formatReset } from "../dashboard-model";
import { ChevronLeftIcon, ChevronRightIcon, RefreshIcon } from "../icons";
import { enabledProviders } from "../personal-analytics";
import { LimitMeter } from "./CapacityMeters";
import { ProviderLogo } from "./ProviderLogo";

const TODAY_PREVIEW_LIMITS = 4;

interface LimitsDashboardProps {
  snapshot: DashboardSnapshot;
  limitOrder: string[];
  trayLimits: TrayLimitPreferences;
  refreshing: boolean;
  onBack(): void;
  onLimitOrderChange(limitOrder: string[]): Promise<void>;
  onTrayLimitsChange(trayLimits: TrayLimitPreferences): Promise<void>;
  onRefresh(): Promise<void>;
}

export function LimitsDashboard({
  snapshot,
  limitOrder,
  trayLimits,
  refreshing,
  onBack,
  onLimitOrderChange,
  onTrayLimitsChange,
  onRefresh
}: LimitsDashboardProps): React.JSX.Element {
  const providers = enabledProviders(snapshot);
  const entries = rankedLimitEntries(providers, limitOrder);
  const rankedKeys = entries.map(limitEntryKey);
  const entriesByKey = new Map(entries.map((entry) => [limitEntryKey(entry), entry]));
  const quietProviders = providers.filter((provider) => limitEntries([provider]).length === 0);
  // A drag reorders locally first; the saved ranking catches up once the write lands.
  const [draggedKeys, setDraggedKeys] = useState<string[] | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const keys = draggedKeys && holdsSameKeys(draggedKeys, rankedKeys) ? draggedKeys : rankedKeys;
  const trayCount = keys.filter((key) => showsInTray(trayLimits, key)).length;

  async function commitOrder(nextKeys: string[]): Promise<void> {
    setDraggedKeys(nextKeys);
    try {
      await onLimitOrderChange(mergeLimitOrder(limitOrder, nextKeys));
    } finally {
      setDraggedKeys(null);
    }
  }

  function moveLimit(key: string, direction: -1 | 1): void {
    const currentIndex = keys.indexOf(key);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= keys.length) return;
    const nextKeys = [...keys];
    [nextKeys[currentIndex], nextKeys[nextIndex]] = [nextKeys[nextIndex], nextKeys[currentIndex]];
    setAnnouncement(`${limitName(entriesByKey.get(key))} moved to priority ${nextIndex + 1}.`);
    void commitOrder(nextKeys);
  }

  function setTrayVisibility(key: string, shown: boolean): void {
    void onTrayLimitsChange({ ...trayLimits, [key]: shown });
  }

  return (
    <div className="atlas-page atlas-limits-page">
      <div className="atlas-toolbar">
        <div className="atlas-toolbar-cluster">
          <Button onPress={onBack} variant="secondary">
            <ChevronLeftIcon />
            <span>Today</span>
          </Button>
        </div>
        <div className="atlas-toolbar-actions">
          <Button isPending={refreshing} onPress={() => void onRefresh()} variant="secondary">
            <RefreshIcon />
            <span>{refreshing ? "Checking…" : "Check all"}</span>
          </Button>
        </div>
      </div>

      <header className="atlas-page-header">
        <p className="atlas-kicker">Live capacity</p>
        <h1 className="atlas-page-title">All tool limits</h1>
        <p className="atlas-hero-description" id="limit-ranking-instructions">
          Every limit ranks on its own, so Claude weekly and Cursor API can sit side by side. Drag a row, or use
          the arrow controls, and the top {TODAY_PREVIEW_LIMITS} appear on Today. The tray switch decides whether
          a limit is listed when you right-click the tray icon.
        </p>
      </header>

      <p aria-live="polite" className="sr-only" role="status">{announcement}</p>

      {keys.length > 0 ? (
        <>
          <div className="atlas-limit-rank-legend">
            <span>{keys.length} {keys.length === 1 ? "limit" : "limits"} ranked</span>
            <span>{trayCount} in the tray menu</span>
          </div>
          <Reorder.Group
            aria-describedby="limit-ranking-instructions"
            aria-label="Ranked tool limits"
            as="ol"
            axis="y"
            className="atlas-limit-rank-list"
            onReorder={setDraggedKeys}
            values={keys}
          >
            {keys.map((key, index) => {
              const entry = entriesByKey.get(key);
              return entry ? (
                <LimitRankRow
                  entry={entry}
                  index={index}
                  key={key}
                  limitKey={key}
                  onDragSettled={() => { if (draggedKeys) void commitOrder(draggedKeys); }}
                  onMove={(direction) => moveLimit(key, direction)}
                  onTrayChange={(shown) => setTrayVisibility(key, shown)}
                  total={keys.length}
                  trayVisible={showsInTray(trayLimits, key)}
                />
              ) : null;
            })}
          </Reorder.Group>
        </>
      ) : (
        <LimitsEmpty />
      )}

      {quietProviders.length > 0 ? (
        <section aria-labelledby="quiet-tools-heading" className="atlas-limit-quiet">
          <h2 id="quiet-tools-heading">Not reporting limits</h2>
          <ul>
            {quietProviders.map((provider) => (
              <li key={provider.id}>
                <ProviderLogo mini providerID={provider.id} providerName={provider.name} />
                <strong>{provider.name}</strong>
                <span>{quietReason(provider)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function LimitRankRow({
  entry,
  limitKey,
  index,
  total,
  trayVisible,
  onMove,
  onTrayChange,
  onDragSettled
}: {
  entry: LimitEntry;
  limitKey: string;
  index: number;
  total: number;
  trayVisible: boolean;
  onMove(direction: -1 | 1): void;
  onTrayChange(shown: boolean): void;
  onDragSettled(): void;
}): React.JSX.Element {
  const dragControls = useDragControls();
  const name = limitName(entry);

  return (
    <Reorder.Item
      as="li"
      className="atlas-limit-rank-row"
      dragControls={dragControls}
      dragListener={false}
      onDragEnd={onDragSettled}
      // The row drags from anywhere except its own controls, which keep their own presses.
      onPointerDown={(event) => {
        if ((event.target as Element).closest("button, input, [data-slot='switch']")) return;
        dragControls.start(event);
      }}
      value={limitKey}
    >
      <span aria-hidden="true" className="atlas-limit-rank-row__handle">
        <i /><i /><i /><i /><i /><i />
      </span>
      <span className="atlas-limit-rank-row__priority">{index + 1}</span>
      <div className="atlas-limit-rank-row__identity">
        <ProviderLogo compact providerID={entry.provider.id} providerName={entry.provider.name} />
        <div>
          <strong>{name}</strong>
          <p>{entry.provider.identity?.plan ?? entry.provider.name} · {formatReset(entry.window)}</p>
        </div>
      </div>
      <div className="atlas-limit-rank-row__meter">
        <LimitMeter compact entry={entry} showHeader={false} />
      </div>
      <div className="atlas-limit-rank-row__actions">
        {/* The switch renders its own label, so this caption stays a plain span. */}
        <span className="atlas-limit-rank-row__tray">
          <span aria-hidden="true">Tray</span>
          <Switch
            aria-label={`Show ${name} in the tray menu`}
            isSelected={trayVisible}
            onChange={onTrayChange}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
        </span>
        <div className="atlas-limit-rank-row__rank-actions">
          <Button
            aria-label={`Move ${name} earlier`}
            className="atlas-limit-rank-row__rank-button atlas-limit-rank-row__rank-button--up"
            isDisabled={index === 0}
            isIconOnly
            onPress={() => onMove(-1)}
            size="sm"
            variant="tertiary"
          >
            <ChevronRightIcon />
          </Button>
          <Button
            aria-label={`Move ${name} later`}
            className="atlas-limit-rank-row__rank-button atlas-limit-rank-row__rank-button--down"
            isDisabled={index === total - 1}
            isIconOnly
            onPress={() => onMove(1)}
            size="sm"
            variant="tertiary"
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>
    </Reorder.Item>
  );
}

function LimitsEmpty(): React.JSX.Element {
  return (
    <div className="atlas-limit-rank-empty">
      <strong>No live limits</strong>
      <p>Active tools are connected, but none of them reported a metered window yet.</p>
    </div>
  );
}

function limitName(entry: LimitEntry | undefined): string {
  return entry ? `${entry.provider.name} ${entry.window.label}` : "This limit";
}

function quietReason(provider: DashboardProvider): string {
  if (provider.error) return provider.error.message;
  return "Connected, but it did not report a metered window.";
}

function holdsSameKeys(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((key) => right.includes(key));
}
