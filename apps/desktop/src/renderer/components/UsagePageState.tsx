/* eslint-disable react-refresh/only-export-components -- Loading copy is shared by the startup screen and the in-dashboard refresh ring. */

import { Button, ProgressCircle } from "@heroui/react";
import type { EngineStatus, LocalImportProgress, RefreshProgress } from "../../shared/desktop-api";
import { AlertIcon, ProvidersIcon } from "../icons";
import { EmptyState } from "./UsagePrimitives";

export function UsageLoading({
  engineStatus,
  progress
}: {
  engineStatus: EngineStatus;
  progress: RefreshProgress | null;
}): React.JSX.Element {
  const label = refreshStatusLabel(progress, engineStatus);

  return (
    <div className="atlas-startup atlas-page" aria-busy="true">
      <h1 className="atlas-page-title">Loading your usage</h1>
      <UsageProgressRing label={label} progress={progress} size="lg" />
      <p className="atlas-startup__status" aria-live="polite">{label}</p>
    </div>
  );
}

export function UsageRefreshStatus({
  engineStatus,
  progress
}: {
  engineStatus: EngineStatus;
  progress: RefreshProgress | null;
}): React.JSX.Element {
  const label = refreshStatusLabel(progress, engineStatus, "Updating usage");

  return (
    <div className="atlas-refresh-status" role="status">
      <UsageProgressRing label={label} progress={progress} size="sm" />
      <p className="atlas-refresh-status__label">{label}</p>
    </div>
  );
}

export function UsageStorageStatus({ progress }: { progress: LocalImportProgress }): React.JSX.Element {
  const label = progress.error ?? (progress.total > 0
    ? `Saving local history · ${progress.completed.toLocaleString()} of ${progress.total.toLocaleString()} records`
    : "Preparing local history");
  return <div className="atlas-refresh-status" role="status">
    {!progress.error && <UsageProgressRing label={label} size="sm" progress={{ ...progress,
      providerID: null, providerName: null, status: "started" }} />}
    <p className="atlas-refresh-status__label">{label}</p>
  </div>;
}

function UsageProgressRing({
  label,
  progress,
  size
}: {
  label: string;
  progress: RefreshProgress | null;
  size: "sm" | "lg";
}): React.JSX.Element {
  const total = progress?.total ?? 0;
  const completed = progress?.completed ?? 0;
  const determinate = total > 0;

  return (
    <div className={`atlas-progress-ring atlas-progress-ring--${size}`}>
      <ProgressCircle
        aria-label={label}
        color="default"
        isIndeterminate={!determinate}
        maxValue={Math.max(total, 1)}
        size={size === "lg" ? "lg" : "sm"}
        value={completed}
      >
        <ProgressCircle.Track>
          <ProgressCircle.TrackCircle />
          <ProgressCircle.FillCircle />
        </ProgressCircle.Track>
      </ProgressCircle>
      {size === "lg" && determinate ? (
        <span aria-hidden="true" className="atlas-progress-ring__fraction">
          <span className="atlas-progress-ring__completed">{completed}</span>
          <span className="atlas-progress-ring__total">/{total}</span>
        </span>
      ) : null}
    </div>
  );
}

export function refreshStatusLabel(
  progress: RefreshProgress | null,
  engineStatus: EngineStatus,
  fallback = "Opening saved usage"
): string {
  if (progress && progress.total > 0) {
    if (progress.status === "started" && progress.providerName) {
      return `Updating ${progress.providerName}`;
    }
    if (progress.completed >= progress.total) return "Finishing the usage update";
    return "Updating usage";
  }
  if (engineStatus === "starting") return "Starting the local engine";
  return fallback;
}

export function UsageFailure({ error, onRetry }: { error: string; onRetry(): Promise<void> }): React.JSX.Element {
  return (
    <div className="grid min-h-[70vh] place-items-center p-6" role="alert">
      <EmptyState className="max-w-md" size="lg">
        <EmptyState.Header>
          <EmptyState.Media className="text-danger" variant="icon"><AlertIcon className="size-6" /></EmptyState.Media>
          <EmptyState.Title>Usage is temporarily unavailable</EmptyState.Title>
          <EmptyState.Description>{error}</EmptyState.Description>
        </EmptyState.Header>
        <EmptyState.Content><Button onPress={() => void onRetry()}>Try again</Button></EmptyState.Content>
      </EmptyState>
    </div>
  );
}

export function UsageEmpty({ onOpenSettings }: { onOpenSettings(): void }): React.JSX.Element {
  return (
    <div className="grid min-h-[70vh] place-items-center p-6">
      <EmptyState className="max-w-md" size="lg">
        <EmptyState.Header>
          <EmptyState.Media variant="icon"><ProvidersIcon className="size-6" /></EmptyState.Media>
          <EmptyState.Title>No tools are reporting yet</EmptyState.Title>
          <EmptyState.Description>Choose the AI tools you use, then UsageAtlas will collect their local usage summaries.</EmptyState.Description>
        </EmptyState.Header>
        <EmptyState.Content><Button onPress={onOpenSettings}>Open settings</Button></EmptyState.Content>
      </EmptyState>
    </div>
  );
}
