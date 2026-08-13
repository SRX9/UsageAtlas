import type { DashboardProvider } from "@usageatlas/contracts";
import { Button, Card, Skeleton, Spinner, Switch } from "@heroui/react";
import { DESKTOP_VERSION } from "../../shared/version";
import type { DesktopPreferences } from "../../shared/desktop-api";
import { ExternalIcon } from "../icons";
import { ProviderLogo } from "./ProviderLogo";

interface SettingsProps {
  preferences: DesktopPreferences | null;
  backgroundError: string | null;
  customBackgroundUrl: string | null;
  saving: boolean;
  onUpdate(patch: Partial<DesktopPreferences>): Promise<void>;
  onChooseCustomBackground(): Promise<void>;
  onOpenExternal(url: string): Promise<void>;
  providers: DashboardProvider[];
  providerSaving: string | null;
  onSetProviderEnabled(providerID: string, enabled: boolean): Promise<void>;
}

export function Settings({
  preferences,
  backgroundError,
  customBackgroundUrl,
  saving,
  onUpdate,
  onChooseCustomBackground,
  onOpenExternal,
  providers,
  providerSaving,
  onSetProviderEnabled,
}: SettingsProps): React.JSX.Element {
  return (
    <div className="atlas-page atlas-page--narrow">
      <header className="atlas-page-header flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="atlas-kicker">Preferences</p>
          <h1 className="atlas-page-title">Settings</h1>
          <p className="atlas-hero-description">
            Control startup, privacy, and connected sources.
          </p>
        </div>
        <span
          aria-live="polite"
          className="flex min-h-5 items-center gap-2 text-sm text-muted"
          role="status"
        >
          {saving ? (
            <>
              <Spinner size="sm" />
              <span>Saving…</span>
            </>
          ) : null}
        </span>
      </header>

      {!preferences ? (
        <Card className="mt-8" variant="transparent">
          <Skeleton className="h-44 rounded-2xl" />
        </Card>
      ) : (
        <div className="mt-8 grid gap-5">
          <Card variant="transparent">
            <Card.Header>
              <Card.Title>Appearance</Card.Title>
              <Card.Description>
                Choose the image shown behind your dashboard.
              </Card.Description>
            </Card.Header>
            <Card.Content className="mt-2">
              <div className="atlas-wallpaper-setting">
                <div
                  aria-hidden="true"
                  className="atlas-wallpaper-preview"
                  data-custom={
                    preferences.backgroundImage === "custom" &&
                    customBackgroundUrl
                      ? "true"
                      : "false"
                  }
                  style={
                    customBackgroundUrl
                      ? ({
                          "--atlas-preview-image": `url("${customBackgroundUrl}")`,
                        } as React.CSSProperties)
                      : undefined
                  }
                />
                <div className="min-w-0 flex-1">
                  <strong className="text-sm font-medium text-foreground">
                    Background image
                  </strong>
                  <p className="mt-1 truncate text-xs text-muted">
                    {preferences.backgroundImage === "custom" &&
                    preferences.customBackgroundName
                      ? preferences.customBackgroundName
                      : "UsageAtlas default"}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    JPG, PNG, or WebP up to 25 MB.
                  </p>
                  <p
                    className="atlas-wallpaper-error mt-1 text-xs"
                    role="alert"
                  >
                    {backgroundError ?? ""}
                  </p>
                </div>
                <div className="atlas-wallpaper-actions">
                  {customBackgroundUrl &&
                  preferences.backgroundImage === "default" ? (
                    <Button
                      isDisabled={saving}
                      onPress={() =>
                        void onUpdate({ backgroundImage: "custom" })
                      }
                      variant="secondary"
                    >
                      Use custom
                    </Button>
                  ) : null}
                  {preferences.backgroundImage === "custom" ? (
                    <Button
                      isDisabled={saving}
                      onPress={() =>
                        void onUpdate({ backgroundImage: "default" })
                      }
                      variant="secondary"
                    >
                      Use default
                    </Button>
                  ) : null}
                  <Button
                    isDisabled={saving}
                    onPress={() => void onChooseCustomBackground()}
                    variant="outline"
                  >
                    {customBackgroundUrl ? "Change image" : "Choose image"}
                  </Button>
                </div>
              </div>
            </Card.Content>
          </Card>

          <Card variant="transparent">
            <Card.Header>
              <Card.Title>General</Card.Title>
              <Card.Description>
                How UsageAtlas behaves on this computer.
              </Card.Description>
            </Card.Header>
            <Card.Content className="atlas-settings-list mt-2">
              <SettingRow
                checked={preferences.launchAtLogin}
                description="Start quietly when you sign in."
                label="Launch at login"
                onChange={(launchAtLogin) => onUpdate({ launchAtLogin })}
              />
              <SettingRow
                checked={preferences.minimizeToTray}
                description="Keep usage checks running when the window closes."
                label="Keep running in the tray"
                onChange={(minimizeToTray) => onUpdate({ minimizeToTray })}
              />
            </Card.Content>
          </Card>

          <Card variant="transparent">
            <Card.Header>
              <Card.Title>Sources</Card.Title>
              <Card.Description>
                Choose which AI tools appear in your analytics.
              </Card.Description>
            </Card.Header>
            <Card.Content className="atlas-settings-list mt-2">
              {providers.length ? (
                providers.map((provider) => (
                  <SettingRow
                    checked={provider.enabled}
                    description={providerDescription(provider)}
                    disabled={providerSaving === provider.id}
                    key={provider.id}
                    label={provider.name}
                    leading={
                      <ProviderLogo
                        compact
                        providerID={provider.id}
                        providerName={provider.name}
                      />
                    }
                    onChange={(enabled) =>
                      onSetProviderEnabled(provider.id, enabled)
                    }
                  />
                ))
              ) : (
                <p className="px-3 py-5 text-sm text-muted">
                  No supported sources were detected yet.
                </p>
              )}
            </Card.Content>
          </Card>

          <Card variant="transparent">
            <Card.Header>
              <Card.Title>Usage count</Card.Title>
              <Card.Description>
                A general headcount of how many people use UsageAtlas.
              </Card.Description>
            </Card.Header>
            <Card.Content className="atlas-settings-list mt-2">
              <SettingRow
                checked={preferences.anonymousAnalytics}
                description="Completely anonymous. It only counts this general app analytics so we know how many people are using the app. Nothing else leaves your computer."
                label="Allow General App analytics in the count"
                onChange={(anonymousAnalytics) =>
                  onUpdate({ anonymousAnalytics })
                }
              />
            </Card.Content>
          </Card>

          <footer className="flex flex-col items-start gap-4 px-1 py-3 sm:flex-row sm:items-center">
            <div>
              <strong className="text-sm font-medium">UsageAtlas</strong>
              <p className="mt-1 text-xs text-muted">
                Version {DESKTOP_VERSION} · Local-first desktop app
              </p>
            </div>
            <Button
              className="sm:ms-auto"
              onPress={() => void onOpenExternal("https://usageatlas.com")}
              variant="ghost"
            >
              <span>Open documentation</span>
              <ExternalIcon className="size-4" />
            </Button>
          </footer>
        </div>
      )}
    </div>
  );
}

function SettingRow({
  label,
  description,
  checked,
  disabled = false,
  leading,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  leading?: React.ReactNode;
  onChange(value: boolean): Promise<void>;
}): React.JSX.Element {
  return (
    <div className="atlas-setting-row flex min-h-20 items-center gap-4 p-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {leading}
        <div className="min-w-0">
          <strong className="text-sm font-medium text-foreground">
            {label}
          </strong>
          <p className="mt-1 text-xs text-muted">{description}</p>
        </div>
      </div>
      <Switch
        aria-label={label}
        isDisabled={disabled}
        isSelected={checked}
        onChange={(value) => void onChange(value)}
      >
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
      </Switch>
    </div>
  );
}

function providerDescription(provider: DashboardProvider): string {
  if (!provider.enabled) return "Disabled. Enable to check this provider.";
  if (provider.error?.code === "auth_required")
    return "Sign in again, then refresh.";
  if (provider.error?.code === "credentials_missing")
    return "Not detected on this computer yet.";
  if (provider.source === "cursor_app")
    return provider.analytics
      ? "Connected through Cursor with detailed dashboard history."
      : "Connected through the Cursor desktop app.";
  if (provider.source === "opencode_local_estimate")
    return "OpenCode Go with local quota estimates.";
  if (provider.id === "opencode" && provider.analytics)
    return "Reading local OpenCode activity.";
  return provider.identity?.plan ?? "Usage monitoring available";
}
