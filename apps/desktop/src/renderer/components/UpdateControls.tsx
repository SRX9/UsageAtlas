import { Button, Card, Input, Label, Radio, RadioGroup, Spinner, TextField } from "@heroui/react";
import type { DesktopUpdateState, UpdateChannel } from "../../shared/desktop-api";
import { isUpdateChannel } from "../../shared/desktop-api";
import { DESKTOP_VERSION } from "../../shared/version";
import { CheckIcon, DownloadIcon, RefreshIcon } from "../icons";

const CHANNELS: { value: UpdateChannel; label: string; description: string }[] = [
  {
    value: "fork",
    label: "Unofficial fork",
    description:
      "Builds from github.com/Artleboss2/UsageAtlas-Unofficial, with the private provider readers and appearance settings."
  },
  {
    value: "upstream",
    label: "Official app",
    description:
      "The original project's releases. Installing one replaces this fork's private providers with the official build."
  },
  {
    value: "custom",
    label: "Another repository",
    description:
      "Releases from a GitHub repository you name, published as owner/name (for example yourname/UsageAtlas-Unofficial)."
  }
];

interface UpdateControlsProps {
  state: DesktopUpdateState | null;
  onCheck(): Promise<void>;
  onInstall(): Promise<void>;
  onRollback?(): Promise<void>;
  channel?: UpdateChannel;
  repository?: string;
  onChangeChannel?(channel: UpdateChannel): Promise<void>;
  onChangeRepository?(repository: string): Promise<void>;
}

export function UpdateSettings({
  state,
  onCheck,
  onInstall,
  onRollback,
  channel,
  repository,
  onChangeChannel,
  onChangeRepository
}: UpdateControlsProps): React.JSX.Element {
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
        <div className="atlas-update-settings__actions">
          <Button isDisabled={busy || unavailable} onPress={() => void (ready || available ? onInstall() : onCheck())} variant="secondary">
            {busy ? <Spinner aria-hidden="true" size="sm" /> : ready || available ? <DownloadIcon /> : <RefreshIcon />}
            <span>{label}</span>
          </Button>
          {state?.previousVersion && onRollback ? (
            <Button isDisabled={busy} onPress={() => void onRollback()} variant="ghost">
              <RefreshIcon />
              <span>Roll back to {state.previousVersion}</span>
            </Button>
          ) : null}
        </div>
        {channel !== undefined && onChangeChannel ? (
          <div className="atlas-update-settings__channel">
            <RadioGroup
              isDisabled={busy || unavailable}
              name="update-channel"
              onChange={(value) => {
                if (isUpdateChannel(value)) void onChangeChannel(value);
              }}
              orientation="horizontal"
              value={channel}
              variant="secondary"
            >
              <Label>Updates from</Label>
              {CHANNELS.map((option) => (
                <Radio key={option.value} value={option.value}>
                  <Radio.Content>
                    <Radio.Control className="sr-only">
                      <Radio.Indicator />
                    </Radio.Control>
                    <span>{option.label}</span>
                  </Radio.Content>
                </Radio>
              ))}
            </RadioGroup>
            <p className="atlas-update-settings__hint text-xs text-muted">
              {CHANNELS.find((option) => option.value === channel)?.description}
            </p>
            {channel === "custom" && onChangeRepository ? (
              <div className="atlas-update-settings__repository">
                <TextField
                  isDisabled={busy || unavailable}
                  // Saved on blur or Enter rather than per keystroke, so a half-typed
                  // name never points a check at a repository that does not exist.
                  defaultValue={repository ?? ""}
                  key={repository ?? ""}
                  onBlur={(event) => void onChangeRepository(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void onChangeRepository(event.currentTarget.value);
                  }}
                >
                  <Label>GitHub repository</Label>
                  <Input placeholder="owner/name" />
                </TextField>
              </div>
            ) : null}
          </div>
        ) : null}
      </Card.Content>
    </Card>
  );
}

export function UpdateTag({ state, onCheck, onInstall }: UpdateControlsProps): React.JSX.Element | null {
  if (!state || !["downloading", "ready", "available", "error"].includes(state.status)) return null;
  const downloading = state.status === "downloading";
  const failed = state.status === "error";
  const ready = state.status === "ready";
  const description = downloading ? "Downloading update" : failed
    ? "Update check failed"
    : ready ? "Restart to finish update" : "New update available";
  const version = state.availableVersion ? ` ${state.availableVersion}` : "";
  const title = downloading ? "Downloading the update in the background" : failed
    ? `${state.error ?? "Unable to update."} Check for updates again.`
    : ready
      ? `Version${version} is installed. Restart UsageAtlas to finish.`
      : `Download version${version} of UsageAtlas`;
  return (
    <button
      aria-label={`${description}. ${title}`}
      className="atlas-update-tag no-drag"
      data-state={state.status}
      disabled={downloading}
      onClick={() => void (failed ? onCheck() : onInstall())}
      title={title}
      type="button"
    >
      <span className="atlas-update-tag__description">{description}</span>
      {downloading ? (
        <Spinner aria-hidden="true" size="sm" />
      ) : ready ? (
        <><RefreshIcon /><span>Restart</span></>
      ) : (
        <><DownloadIcon /><span>{failed ? "Retry" : "Update"}</span></>
      )}
    </button>
  );
}
