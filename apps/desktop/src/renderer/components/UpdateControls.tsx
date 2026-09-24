import { Button, Card, Spinner } from "@heroui/react";
import type { DesktopUpdateState } from "../../shared/desktop-api";
import { DESKTOP_VERSION } from "../../shared/version";
import { CheckIcon, DownloadIcon, RefreshIcon } from "../icons";

interface UpdateControlsProps {
  state: DesktopUpdateState | null;
  onCheck(): Promise<void>;
  onInstall(): Promise<void>;
}

export function UpdateSettings({ state, onCheck, onInstall }: UpdateControlsProps): React.JSX.Element {
  const busy = !state || state.status === "checking" || state.status === "downloading";
  const ready = state?.status === "ready";
  const available = state?.status === "available";
  const unavailable = state?.status === "unavailable";
  const label = ready ? "Update and restart" : available ? "Download update" : "Check for updates";
  const version = state?.currentVersion || DESKTOP_VERSION;
  let description = "Check for a newer version of UsageAtlas.";
  if (!state) description = "Loading update status…";
  else if (state.status === "checking") description = "Checking for updates…";
  else if (state.status === "current") description = "You're on the latest version.";
  else if (state.status === "downloading") description = "Downloading the update. You can keep using UsageAtlas.";
  else if (ready) description = "Your update is ready. Updating will restart UsageAtlas.";
  else if (available) description = `Version ${state.availableVersion} is available. Download it to update.`;
  else if (unavailable) description = "Update checks are available in installed builds.";
  else if (state.status === "error") description = state.error ?? "Unable to update. Try checking again.";

  return (
    <Card variant="transparent">
      <Card.Header>
        <Card.Title>App updates</Card.Title>
        <Card.Description>UsageAtlas {version}</Card.Description>
      </Card.Header>
      <Card.Content className="atlas-update-settings">
        <p className="atlas-update-settings__status" data-error={state?.status === "error" || undefined} role="status">
          {state?.status === "current" ? <CheckIcon /> : null}
          <span>{description}</span>
        </p>
        <Button isDisabled={busy || unavailable} onPress={() => void (ready || available ? onInstall() : onCheck())} variant="secondary">
          {busy ? <Spinner aria-hidden="true" size="sm" /> : ready || available ? <DownloadIcon /> : <RefreshIcon />}
          <span>{label}</span>
        </Button>
      </Card.Content>
    </Card>
  );
}

export function UpdateTag({ state, onCheck, onInstall }: UpdateControlsProps): React.JSX.Element | null {
  if (!state || !["downloading", "ready", "available", "error"].includes(state.status)) return null;
  const downloading = state.status === "downloading";
  const failed = state.status === "error";
  const description = downloading ? "Downloading update" : failed ? "Update check failed" : "New update available";
  const title = downloading ? "Downloading the update in the background" : failed
    ? `${state.error ?? "Unable to update."} Check for updates again.`
    : state.status === "ready" ? "Update and restart UsageAtlas" : "Download the latest version of UsageAtlas";
  return (
    <button
      aria-label={`${description}. ${title}`}
      className="atlas-update-tag no-drag"
      disabled={downloading}
      onClick={() => void (failed ? onCheck() : onInstall())}
      title={title}
      type="button"
    >
      <span className="atlas-update-tag__description">{description}</span>
      {downloading ? <Spinner aria-hidden="true" size="sm" /> : <><DownloadIcon /><span>{failed ? "Retry" : "Update"}</span></>}
    </button>
  );
}
