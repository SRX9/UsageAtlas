import type { DashboardProvider, DashboardSnapshot } from "@usageatlas/contracts";
import { Button, Card } from "@heroui/react";
import { useState } from "react";
import {
  limitEntries,
  mergeLimitProviderOrder,
  rankedLimitProviders
} from "../../shared/capacity-model";
import { ChevronLeftIcon, ChevronRightIcon, RefreshIcon } from "../icons";
import { enabledProviders } from "../personal-analytics";
import { AnalyzerNotice, type PageNotice } from "./UsagePageState";
import { LimitMeter } from "./CapacityMeters";
import { ProviderLogo } from "./ProviderLogo";

interface LimitsDashboardProps {
  snapshot: DashboardSnapshot;
  providerOrder: string[];
  refreshing: boolean;
  notice: PageNotice | null;
  onBack(): void;
  onProviderOrderChange(providerOrder: string[]): Promise<void>;
  onRefresh(): Promise<void>;
}

export function LimitsDashboard({
  snapshot,
  providerOrder,
  refreshing,
  notice,
  onBack,
  onProviderOrderChange,
  onRefresh
}: LimitsDashboardProps): React.JSX.Element {
  const providers = rankedLimitProviders(enabledProviders(snapshot), providerOrder);
  const providerIDs = providers.map((provider) => provider.id);
  const [draggedProviderID, setDraggedProviderID] = useState<string | null>(null);
  const [dropTargetID, setDropTargetID] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  function commitVisibleOrder(nextVisibleProviderIDs: string[], providerID: string, providerName: string): void {
    const nextOrder = mergeLimitProviderOrder(providerOrder, nextVisibleProviderIDs);
    void onProviderOrderChange(nextOrder);
    const nextRank = nextVisibleProviderIDs.indexOf(providerID) + 1;
    setAnnouncement(`${providerName} moved to priority ${nextRank}.`);
  }

  function moveProvider(providerID: string, direction: -1 | 1): void {
    const currentIndex = providerIDs.indexOf(providerID);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= providerIDs.length) return;
    const nextIDs = [...providerIDs];
    [nextIDs[currentIndex], nextIDs[nextIndex]] = [nextIDs[nextIndex], nextIDs[currentIndex]];
    const providerName = providers.find((provider) => provider.id === providerID)?.name ?? providerID;
    commitVisibleOrder(nextIDs, providerID, providerName);
  }

  function dropProvider(targetProviderID: string): void {
    if (!draggedProviderID || draggedProviderID === targetProviderID) {
      setDraggedProviderID(null);
      setDropTargetID(null);
      return;
    }
    const nextIDs = [...providerIDs];
    const sourceIndex = nextIDs.indexOf(draggedProviderID);
    const targetIndex = nextIDs.indexOf(targetProviderID);
    if (sourceIndex < 0 || targetIndex < 0) return;
    nextIDs.splice(sourceIndex, 1);
    nextIDs.splice(targetIndex, 0, draggedProviderID);
    const providerName = providers.find((provider) => provider.id === draggedProviderID)?.name ?? draggedProviderID;
    commitVisibleOrder(nextIDs, draggedProviderID, providerName);
    setDraggedProviderID(null);
    setDropTargetID(null);
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

      {notice ? <AnalyzerNotice {...notice} /> : null}

      <header className="atlas-page-header">
        <p className="atlas-kicker">Live capacity</p>
        <h1 className="atlas-page-title">All tool limits</h1>
        <p className="atlas-hero-description" id="limit-ranking-instructions">
          Drag tool blocks to rank the four limits shown on Today. Use the arrow controls for keyboard reordering.
          Tools without a live connection are skipped so the next ranked tool fills the slot.
        </p>
      </header>

      <p aria-live="polite" className="sr-only" role="status">{announcement}</p>
      <div
        aria-describedby="limit-ranking-instructions"
        className="atlas-limits-page__providers"
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
      >
        {providers.map((provider, index) => (
          <div
            className="atlas-provider-rank-item"
            data-dragging={draggedProviderID === provider.id ? "true" : "false"}
            data-drop-target={dropTargetID === provider.id && draggedProviderID !== provider.id ? "true" : "false"}
            draggable
            key={provider.id}
            onDragEnd={() => {
              setDraggedProviderID(null);
              setDropTargetID(null);
            }}
            onDragEnter={() => setDropTargetID(provider.id)}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", provider.id);
              setDraggedProviderID(provider.id);
            }}
            onDrop={(event) => {
              event.preventDefault();
              dropProvider(provider.id);
            }}
          >
            <ProviderLimitsCard
              index={index}
              onMove={(direction) => moveProvider(provider.id, direction)}
              provider={provider}
              total={providers.length}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function ProviderLimitsCard({
  provider,
  index,
  total,
  onMove
}: {
  provider: DashboardProvider;
  index: number;
  total: number;
  onMove(direction: -1 | 1): void;
}): React.JSX.Element {
  const entries = limitEntries([provider]);
  const priority = index + 1;

  return (
    <Card className="atlas-provider-limits" variant="transparent">
      <Card.Header className="atlas-provider-limits__header">
        <div className="atlas-provider-limits__identity">
          <span aria-hidden="true" className="atlas-provider-limits__drag-handle">
            <i /><i /><i /><i /><i /><i />
          </span>
          <ProviderLogo providerID={provider.id} providerName={provider.name} />
          <div>
            <Card.Title>{provider.name}</Card.Title>
            <Card.Description>{provider.identity?.plan ?? "Active tool"}</Card.Description>
          </div>
        </div>
        <div className="atlas-provider-limits__ranking">
          <span className="atlas-provider-limits__priority">Priority {priority}</span>
          <span className="atlas-provider-limits__count">
            {entries.length} {entries.length === 1 ? "limit" : "limits"}
          </span>
          <div className="atlas-provider-limits__rank-actions">
            <Button
              aria-label={`Move ${provider.name} earlier`}
              className="atlas-provider-limits__rank-button atlas-provider-limits__rank-button--up"
              isDisabled={index === 0}
              isIconOnly
              onPress={() => onMove(-1)}
              size="sm"
              variant="tertiary"
            >
              <ChevronRightIcon />
            </Button>
            <Button
              aria-label={`Move ${provider.name} later`}
              className="atlas-provider-limits__rank-button atlas-provider-limits__rank-button--down"
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
      </Card.Header>
      <Card.Content>
        {provider.error ? (
          <ProviderLimitEmpty title="Limits need attention" detail={provider.error.message} />
        ) : entries.length > 0 ? (
          <div className="atlas-provider-limits__meters">
            {entries.map((entry) => (
              <LimitMeter
                entry={entry}
                key={`${entry.provider.id}-${entry.window.kind}`}
                showReset
              />
            ))}
          </div>
        ) : (
          <ProviderLimitEmpty
            detail="This active tool is connected, but it did not report a metered window."
            title="No metered limits"
          />
        )}
      </Card.Content>
    </Card>
  );
}

function ProviderLimitEmpty({ title, detail }: { title: string; detail: string }): React.JSX.Element {
  return (
    <div className="atlas-provider-limits__empty">
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}
