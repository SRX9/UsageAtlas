import { UpdateSettings } from "./UpdateControls";
import { CloudSettings } from "./CloudSettings";
import { SettingsData } from "./SettingsData";
import { SettingsWidget } from "./SettingsWidget";
import type { DashboardProvider } from "@usageatlas/contracts";
import { Button, Card, Label, Radio, RadioGroup, Skeleton, Spinner, Switch } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import type {
  AppMark,
  BackgroundImagePreference,
  BuiltInBackgroundId,
  DesktopPreferences,
  DesktopUpdateState
} from "../../shared/desktop-api";
import {
  ACCENT_TINTS,
  APPEARANCE_DENSITIES,
  APPEARANCE_SURFACES,
  DEFAULT_APPEARANCE,
  DEFAULT_BACKGROUND_IMAGE,
  NUMBER_STYLES,
  TRAY_METRICS,
  isBackgroundImagePreference
} from "../../shared/desktop-api";
import { FORK_HOME_URL } from "../../shared/fork";
import { DESKTOP_VERSION } from "../../shared/version";
import { CheckIcon, ExternalIcon, RefreshIcon } from "../icons";
import {
  ACCENT_TINT_VALUES,
  applyAppearance,
  FONT_OPTIONS,
  FONT_STACKS,
  INK_SWATCHES,
  MARK_OPTIONS,
  THEME_OPTIONS
} from "../appearance";
import { formatTokens } from "../number-format";
import type { MessageKey } from "../i18n";
import { providerConnection, type ProviderConnection } from "../provider-connection";
import { BUILT_IN_WALLPAPERS } from "../wallpapers";
import { ProviderLogo } from "./ProviderLogo";
import { ProviderCredentialForm } from "./ProviderCredentialForm";
import { ProviderDiscovery } from "./ProviderDiscovery";
import { SettingsProviders } from "./SettingsProviders";
import { useI18n } from "../i18n";
import { isQuotaProvider } from "../../shared/quota-providers";
import { LANGUAGES, LANGUAGE_LABELS } from "../../shared/languages";

interface SettingsProps {
  updateState: DesktopUpdateState | null;
  onCheckForUpdates(): Promise<void>;
  onInstallUpdate(): Promise<void>;
  onRollbackUpdate?(): Promise<void>;
  preferences: DesktopPreferences | null;
  backgroundError: string | null;
  customBackgroundUrl: string | null;
  saving: boolean;
  onUpdate(patch: Partial<DesktopPreferences>): Promise<void>;
  onChooseCustomBackground(): Promise<void>;
  onOpenExternal(url: string): Promise<void>;
  onRefresh(): Promise<void>;
  providers: DashboardProvider[];
  providerSaving: string | null;
  refreshing: boolean;
  onSetProviderEnabled(providerID: string, enabled: boolean): Promise<void>;
  /** PNG data URLs for the app marks, so the picker shows what the OS will show. */
  markUrls?: Record<AppMark, string> | null;
  onShowWidget(): Promise<void>;
  onHideWidget(): Promise<void>;
  onExportSettings(): Promise<void>;
  onImportSettings(): Promise<void>;
  onChooseFolder(): Promise<string | null>;
  onChooseExportDirectory(): Promise<string | null>;
  onExportUsage(): Promise<void>;
  onRestartApp(): Promise<void>;
}

type SettingsTab = "general" | "providers" | "appearance" | "widget" | "data";

export function Settings({
  updateState,
  onCheckForUpdates,
  onInstallUpdate,
  onRollbackUpdate,
  preferences,
  backgroundError,
  customBackgroundUrl,
  saving,
  onUpdate,
  onChooseCustomBackground,
  onOpenExternal,
  onRefresh,
  providers,
  providerSaving,
  refreshing,
  onSetProviderEnabled,
  markUrls = null,
  onShowWidget,
  onHideWidget,
  onExportSettings,
  onImportSettings,
  onChooseFolder,
  onChooseExportDirectory,
  onExportUsage,
  onRestartApp
}: SettingsProps): React.JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<SettingsTab>("general");
  const sources = providers.map((provider) => ({
    provider,
    connection: providerConnection(provider),
  }));
  const needsReconnect = sources.some(
    ({ connection }) => connection.needsAttention,
  );
  const appearance = preferences?.appearance ?? DEFAULT_APPEARANCE;
  // The slider previews live, so the type scale is applied to the document at once
  // while the saved preference only follows once the drag settles. The draft holds
  // only the value being dragged, so a saved change always shows through.
  const [scaleDraft, setScaleDraft] = useState<number | null>(null);
  const scale = scaleDraft ?? appearance.fontScale;
  const scaleCommit = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (scaleCommit.current) clearTimeout(scaleCommit.current);
  }, []);

  function previewScale(next: number): void {
    setScaleDraft(next);
    applyAppearance({ ...appearance, fontScale: next });
    if (scaleCommit.current) clearTimeout(scaleCommit.current);
    scaleCommit.current = setTimeout(() => {
      scaleCommit.current = null;
      void onUpdate({ appearance: { ...appearance, fontScale: next } })
        .finally(() => setScaleDraft(null));
    }, 240);
  }

  function setAppearance(patch: Partial<typeof appearance>): void {
    const next = { ...appearance, ...patch };
    applyAppearance(next);
    void onUpdate({ appearance: next });
  }

  return (
    <div className="atlas-page atlas-page--narrow">
      <header className="atlas-page-header flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="atlas-kicker">{t("settings.kicker")}</p>
          <h1 className="atlas-page-title">{t("settings.title")}</h1>
          <p className="atlas-hero-description">{t("settings.subtitle")}</p>
        </div>
        <span
          aria-live="polite"
          className="flex min-h-5 items-center gap-2 text-sm text-muted"
          role="status"
        >
          {saving ? (
            <>
              <Spinner size="sm" />
              <span>{t("settings.saving")}</span>
            </>
          ) : null}
        </span>
      </header>

      <div className="atlas-settings-tabs" role="tablist" aria-label={t("settings.title")}>
        <button
          aria-selected={tab === "general"}
          className="atlas-settings-tabs__tab"
          onClick={() => setTab("general")}
          role="tab"
          type="button"
        >
          {t("settings.generalTab")}
        </button>
        <button
          aria-selected={tab === "providers"}
          className="atlas-settings-tabs__tab"
          onClick={() => setTab("providers")}
          role="tab"
          type="button"
        >
          {t("settings.providersTab")}
        </button>
        <button
          aria-selected={tab === "appearance"}
          className="atlas-settings-tabs__tab"
          onClick={() => setTab("appearance")}
          role="tab"
          type="button"
        >
          {t("settings.appearanceTab")}
        </button>
        <button
          aria-selected={tab === "widget"}
          className="atlas-settings-tabs__tab"
          onClick={() => setTab("widget")}
          role="tab"
          type="button"
        >
          {t("settings.widgetTab")}
        </button>
        <button
          aria-selected={tab === "data"}
          className="atlas-settings-tabs__tab"
          onClick={() => setTab("data")}
          role="tab"
          type="button"
        >
          {t("settings.dataTab")}
        </button>
      </div>

      {!preferences ? (
        <Card className="mt-8" variant="transparent">
          <Skeleton className="h-44 rounded-2xl" />
        </Card>
      ) : (
        <>
          <div className="mt-8 grid gap-5" hidden={tab !== "providers"}>
            <SettingsProviders onSetProviderEnabled={onSetProviderEnabled} />
          </div>

          <div className="mt-8 grid gap-5" hidden={tab !== "general"}>
            <CloudSettings />
            <Card variant="transparent">
              <Card.Header>
                <Card.Title>{t("settings.general.title")}</Card.Title>
                <Card.Description>{t("settings.general.description")}</Card.Description>
              </Card.Header>
              <Card.Content className="atlas-settings-list mt-2">
                <SettingRow
                  checked={preferences.launchAtLogin}
                  description={t("settings.launch.description")}
                  label={t("settings.launch.label")}
                  onChange={(launchAtLogin) => onUpdate({ launchAtLogin })}
                />
                <SettingRow
                  checked={preferences.minimizeToTray}
                  description={t("settings.tray.description")}
                  label={t("settings.tray.label")}
                  onChange={(minimizeToTray) => onUpdate({ minimizeToTray })}
                />
                <SettingRow
                  checked={preferences.startMinimized}
                  description={t("settings.startMinimized.description")}
                  label={t("settings.startMinimized.label")}
                  onChange={(startMinimized) => onUpdate({ startMinimized })}
                />
                <SettingRow
                  checked={preferences.powerSaving}
                  description={t("settings.power.description")}
                  label={t("settings.power.label")}
                  onChange={(powerSaving) => onUpdate({ powerSaving })}
                />
                <label className="atlas-setting-row flex min-h-20 flex-wrap items-center gap-4 p-3">
                  <span className="min-w-0 flex-1">
                    <strong className="text-sm font-medium text-foreground">{t("settings.hotkey.label")}</strong>
                    <span className="mt-1 block text-xs text-muted">{t("settings.hotkey.description")}</span>
                  </span>
                  <input
                    aria-label={t("settings.hotkey.label")}
                    className="atlas-text-field atlas-hotkey-field"
                    defaultValue={preferences.hotkey}
                    onBlur={(event) => {
                      const hotkey = event.target.value.trim();
                      if (hotkey && hotkey !== preferences.hotkey) void onUpdate({ hotkey });
                    }}
                    spellCheck={false}
                  />
                </label>
                <label className="atlas-setting-row flex min-h-20 flex-wrap items-center gap-4 p-3">
                  <span className="min-w-0 flex-1">
                    <strong className="text-sm font-medium text-foreground">{t("settings.pricingSync.label")}</strong>
                    <span className="mt-1 block text-xs text-muted">{t("settings.pricingSync.description")}</span>
                  </span>
                  <select
                    aria-label={t("settings.pricingSync.label")}
                    className="atlas-select"
                    onChange={(event) => void onUpdate({ pricingSyncHours: Number(event.target.value) })}
                    value={preferences.pricingSyncHours}
                  >
                    {[0, 6, 12, 24, 48, 168].map((hours) => (
                      <option key={hours} value={hours}>
                        {hours === 0 ? t("settings.pricingSync.off") : t("settings.pricingSync.hours", { count: hours })}
                      </option>
                    ))}
                  </select>
                </label>
              </Card.Content>
            </Card>

            <Card variant="transparent">
              <Card.Header>
                <Card.Title>{t("settings.sources.title")}</Card.Title>
                <Card.Description>{t("settings.sources.description")}</Card.Description>
              </Card.Header>
              <Card.Content className="atlas-settings-list mt-2">
                {sources.length ? (
                  sources.map(({ provider, connection }) => (
                    <div key={provider.id}>
                    <SettingRow
                      checked={provider.enabled}
                      description={<ConnectionCopy connection={connection} />}
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
                      status={
                        connection.needsAttention || connection.state === "checking" ? (
                          <span
                            className="atlas-source-pill"
                            data-connection={connection.state}
                          >
                            {connection.label}
                          </span>
                        ) : null
                      }
                    />
                    {isQuotaProvider(provider.id) ? <ProviderCredentialForm provider={provider.id} /> : null}
                    </div>
                  ))
                ) : (
                  <p className="px-3 py-5 text-sm text-muted" role="status">
                    {t(refreshing ? "settings.sources.checking" : "settings.sources.empty")}
                  </p>
                )}
                {needsReconnect ? (
                  <div className="atlas-source-recheck">
                    <Button
                      isPending={refreshing}
                      onPress={() => void onRefresh()}
                      variant="outline"
                    >
                      <span>{t("settings.sources.recheck")}</span>
                      <RefreshIcon
                        className={`size-4${refreshing ? " animate-spin" : ""}`}
                      />
                    </Button>
                  </div>
                ) : null}
              </Card.Content>
            </Card>

            <ProviderDiscovery />

            <Card variant="transparent">
              <Card.Header>
                <Card.Title>{t("settings.language.title")}</Card.Title>
                <Card.Description>{t("settings.language.description")}</Card.Description>
              </Card.Header>
              <Card.Content className="mt-2">
                <div aria-label={t("settings.language.label")} className="atlas-language-options" role="radiogroup">
                  {LANGUAGES.map((language) => (
                    <button
                      aria-checked={preferences.language === language}
                      className="atlas-language-option"
                      key={language}
                      onClick={() => void onUpdate({ language })}
                      role="radio"
                      type="button"
                    >
                      <span>{LANGUAGE_LABELS[language]}</span>
                      {preferences.language === language ? (
                        <span aria-hidden="true" className="atlas-language-option__check">
                          <CheckIcon />
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </Card.Content>
            </Card>

            <Card variant="transparent">
              <Card.Header>
                <Card.Title>{t("settings.usage.title")}</Card.Title>
                <Card.Description>{t("settings.usage.description")}</Card.Description>
              </Card.Header>
              <Card.Content className="atlas-settings-list mt-2">
                <SettingRow
                  checked={preferences.anonymousAnalytics}
                  description={t("settings.usage.allowDescription")}
                  label={t("settings.usage.allow")}
                  onChange={(anonymousAnalytics) =>
                    onUpdate({ anonymousAnalytics })
                  }
                />
              </Card.Content>
            </Card>

            <UpdateSettings
              channel={preferences.updateChannel}
              onChangeChannel={(updateChannel) => onUpdate({ updateChannel })}
              onChangeRepository={(updateRepository) => onUpdate({ updateRepository })}
              repository={preferences.updateRepository}
              onCheck={onCheckForUpdates}
              onInstall={onInstallUpdate}
              onRollback={onRollbackUpdate}
              state={updateState}
            />

            <footer className="flex flex-col items-start gap-4 px-1 py-3 sm:flex-row sm:items-center">
              <div>
                <strong className="text-sm font-medium">UsageAtlas — unofficial fork</strong>
                <p className="mt-1 text-xs text-muted">
                  Version {DESKTOP_VERSION} · Local-first desktop app · Not affiliated with, endorsed by,
                  or supported by UsageAtlas
                </p>
              </div>
              <Button
                className="sm:ms-auto"
                onPress={() => void onOpenExternal(FORK_HOME_URL)}
                variant="ghost"
              >
                <span>Open fork documentation</span>
                <ExternalIcon className="size-4" />
              </Button>
            </footer>
          </div>

          <div className="mt-8 grid gap-5" hidden={tab !== "appearance"}>
            <Card variant="transparent">
              <Card.Header>
                <Card.Title>{t("settings.theme.title")}</Card.Title>
                <Card.Description>{t("settings.theme.description")}</Card.Description>
              </Card.Header>
              <Card.Content className="mt-2">
                <div className="atlas-theme-grid" role="radiogroup" aria-label={t("settings.theme.aria")}>
                  {THEME_OPTIONS.map((option) => (
                    <button
                      aria-checked={appearance.theme === option.id}
                      className="atlas-theme-tile"
                      data-theme-preview={option.id}
                      key={option.id}
                      onClick={() => setAppearance({ theme: option.id })}
                      role="radio"
                      type="button"
                    >
                      <span aria-hidden="true" className="atlas-theme-tile__swatch" />
                      <span className="atlas-theme-tile__label">
                        {t(`option.theme.${option.id}` as MessageKey)}
                      </span>
                      <span className="atlas-theme-tile__note">
                        {t(`option.theme.${option.id}.note` as MessageKey)}
                      </span>
                      {appearance.theme === option.id ? (
                        <span aria-hidden="true" className="atlas-font-tile__check">
                          <CheckIcon />
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </Card.Content>
            </Card>

            <Card variant="transparent">
              <Card.Header>
                <Card.Title>{t("settings.preview.title")}</Card.Title>
                <Card.Description>{t("settings.preview.description")}</Card.Description>
              </Card.Header>
              <Card.Content className="mt-2">
                <div
                  className="atlas-appearance-preview"
                  style={{
                    fontFamily: FONT_STACKS[appearance.font],
                    color: appearance.textColor ?? undefined
                  }}
                >
                  <p className="atlas-appearance-preview__kicker">{t("settings.preview.kicker")}</p>
                  <p className="atlas-appearance-preview__value">{formatTokens(1_284_930)}</p>
                  <p className="atlas-appearance-preview__meta">{t("settings.preview.meta")}</p>
                </div>
              </Card.Content>
            </Card>

            <Card variant="transparent">
              <Card.Header>
                <Card.Title>{t("settings.font.title")}</Card.Title>
                <Card.Description>{t("settings.font.description")}</Card.Description>
              </Card.Header>
              <Card.Content className="mt-2">
                <div className="atlas-font-grid" role="radiogroup" aria-label={t("settings.font.aria")}>
                  {FONT_OPTIONS.map((option) => (
                    <button
                      aria-checked={appearance.font === option.id}
                      className="atlas-font-tile"
                      key={option.id}
                      onClick={() => setAppearance({ font: option.id })}
                      role="radio"
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className="atlas-font-tile__sample"
                        style={{ fontFamily: FONT_STACKS[option.id] }}
                      >
                        Aa
                      </span>
                      <span className="atlas-font-tile__label">{option.label}</span>
                      <span className="atlas-font-tile__note">
                        {t(`option.font.${option.id}` as MessageKey)}
                      </span>
                      {appearance.font === option.id ? (
                        <span aria-hidden="true" className="atlas-font-tile__check">
                          <CheckIcon />
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </Card.Content>
            </Card>

            <Card variant="transparent">
              <Card.Header>
                <Card.Title>{t("settings.textSize.title")}</Card.Title>
                <Card.Description>{t("settings.textSize.description")}</Card.Description>
              </Card.Header>
              <Card.Content className="mt-2">
                <div className="atlas-appearance-scale">
                  <span aria-hidden="true" className="atlas-appearance-scale__edge">A</span>
                  <input
                    aria-label={t("settings.textSize.aria")}
                    className="atlas-slider"
                    max={130}
                    min={85}
                    onChange={(event) => previewScale(Number(event.target.value) / 100)}
                    step={1}
                    type="range"
                    value={Math.round(scale * 100)}
                  />
                  <span aria-hidden="true" className="atlas-appearance-scale__edge atlas-appearance-scale__edge--large">A</span>
                  <output className="atlas-appearance-scale__value">{Math.round(scale * 100)}%</output>
                </div>
              </Card.Content>
            </Card>

            <Card variant="transparent">
              <Card.Header>
                <Card.Title>{t("settings.ink.title")}</Card.Title>
                <Card.Description>{t("settings.ink.description")}</Card.Description>
              </Card.Header>
              <Card.Content className="mt-2">
                <div className="atlas-ink-swatches">
                  {INK_SWATCHES.map((swatch) => {
                    const label = t(`option.ink.${swatch.id}` as MessageKey);
                    return (
                    <button
                      aria-label={label}
                      aria-pressed={appearance.textColor === swatch.value}
                      className="atlas-ink-swatch"
                      data-theme={swatch.value === null ? "true" : undefined}
                      key={swatch.id}
                      onClick={() => setAppearance({ textColor: swatch.value })}
                      style={swatch.value ? { background: swatch.value } : undefined}
                      title={label}
                      type="button"
                    >
                      {appearance.textColor === swatch.value ? <CheckIcon /> : null}
                    </button>
                    );
                  })}
                  <label className="atlas-ink-custom">
                    <span>{t("settings.ink.custom")}</span>
                    <input
                      aria-label={t("settings.ink.aria")}
                      onChange={(event) => setAppearance({ textColor: event.target.value })}
                      type="color"
                      value={appearance.textColor ?? "#1d1d1f"}
                    />
                  </label>
                </div>
              </Card.Content>
            </Card>

            <Card variant="transparent">
              <Card.Header>
                <Card.Title>{t("settings.numbers.title")}</Card.Title>
                <Card.Description>{t("settings.numbers.description")}</Card.Description>
              </Card.Header>
              <Card.Content className="mt-2">
                <div aria-label={t("settings.numbers.aria")} className="atlas-choice-tiles" role="radiogroup">
                  {NUMBER_STYLES.map((style) => (
                    <button
                      aria-checked={appearance.numberStyle === style}
                      className="atlas-choice-tile"
                      key={style}
                      onClick={() => setAppearance({ numberStyle: style })}
                      role="radio"
                      type="button"
                    >
                      <span className="atlas-choice-tile__sample">
                        {style === "exact" ? "1,284,930" : "1.3M"}
                      </span>
                      <span className="atlas-choice-tile__label">
                        {t(`option.number.${style}` as MessageKey)}
                      </span>
                    </button>
                  ))}
                </div>
              </Card.Content>
            </Card>

            <Card variant="transparent">
              <Card.Header>
                <Card.Title>{t("settings.accent.title")}</Card.Title>
                <Card.Description>{t("settings.accent.description")}</Card.Description>
              </Card.Header>
              <Card.Content className="mt-2">
                <div aria-label={t("settings.accent.aria")} className="atlas-ink-swatches" role="radiogroup">
                  {ACCENT_TINTS.map((tint) => {
                    const label = t(`option.accent.${tint}` as MessageKey);
                    const value = ACCENT_TINT_VALUES[tint];
                    return (
                      <button
                        aria-checked={appearance.accent === tint}
                        aria-label={label}
                        className="atlas-ink-swatch"
                        data-theme={tint === "system" ? "true" : undefined}
                        key={tint}
                        onClick={() => setAppearance({ accent: tint })}
                        role="radio"
                        style={value ? { background: value.accent } : undefined}
                        title={label}
                        type="button"
                      >
                        {appearance.accent === tint ? <CheckIcon /> : null}
                      </button>
                    );
                  })}
                </div>
              </Card.Content>
            </Card>

            <Card variant="transparent">
              <Card.Header>
                <Card.Title>{t("settings.surface.title")}</Card.Title>
                <Card.Description>{t("settings.surface.description")}</Card.Description>
              </Card.Header>
              <Card.Content className="mt-2">
                <div aria-label={t("settings.surface.title")} className="atlas-choice-tiles" role="radiogroup">
                  {APPEARANCE_SURFACES.map((surface) => (
                    <button
                      aria-checked={appearance.surface === surface}
                      className="atlas-choice-tile"
                      key={surface}
                      onClick={() => setAppearance({ surface })}
                      role="radio"
                      type="button"
                    >
                      <span aria-hidden="true" className="atlas-choice-tile__swatch" data-surface={surface} />
                      <span className="atlas-choice-tile__label">
                        {t(`option.surface.${surface}` as MessageKey)}
                      </span>
                    </button>
                  ))}
                </div>
              </Card.Content>
            </Card>

            <Card variant="transparent">
              <Card.Header>
                <Card.Title>{t("settings.motion.title")}</Card.Title>
                <Card.Description>{t("settings.motion.description")}</Card.Description>
              </Card.Header>
              <Card.Content className="atlas-settings-list mt-2">
                <SettingRow
                  checked={appearance.animate}
                  description={t("settings.motion.switchDescription")}
                  label={t("settings.motion.label")}
                  onChange={(animate) => {
                    setAppearance({ animate });
                    return Promise.resolve();
                  }}
                />
              </Card.Content>
            </Card>

            <Card variant="transparent">
              <Card.Header>
                <Card.Title>{t("settings.density.title")}</Card.Title>
                <Card.Description>{t("settings.density.description")}</Card.Description>
              </Card.Header>
              <Card.Content className="mt-2">
                <div aria-label={t("settings.density.title")} className="atlas-choice-tiles" role="radiogroup">
                  {APPEARANCE_DENSITIES.map((density) => (
                    <button
                      aria-checked={appearance.density === density}
                      className="atlas-choice-tile"
                      key={density}
                      onClick={() => setAppearance({ density })}
                      role="radio"
                      type="button"
                    >
                      <span className="atlas-choice-tile__sample">
                        {density === "compact" ? "▦" : "▢"}
                      </span>
                      <span className="atlas-choice-tile__label">
                        {t(`option.density.${density}` as MessageKey)}
                      </span>
                    </button>
                  ))}
                </div>
              </Card.Content>
            </Card>

            <Card variant="transparent">
              <Card.Header>
                <Card.Title>{t("settings.window.title")}</Card.Title>
                <Card.Description>{t("settings.window.description")}</Card.Description>
              </Card.Header>
              <Card.Content className="atlas-settings-list mt-2">
                <div className="atlas-setting-row flex min-h-24 flex-col gap-3 p-3">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <strong className="text-sm font-medium text-foreground">{t("settings.window.opacity")}</strong>
                      <p className="mt-1 text-xs text-muted">{t("settings.window.opacityDescription")}</p>
                    </div>
                    <output className="text-sm tabular-nums text-muted">{Math.round(appearance.windowOpacity * 100)}%</output>
                  </div>
                  <input
                    aria-label={t("settings.window.opacity")}
                    className="atlas-slider"
                    max={100}
                    min={70}
                    onChange={(event) => setAppearance({ windowOpacity: Number(event.target.value) / 100 })}
                    step={1}
                    type="range"
                    value={Math.round(appearance.windowOpacity * 100)}
                  />
                </div>
                <div className="atlas-setting-row flex min-h-24 flex-col gap-3 p-3">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <strong className="text-sm font-medium text-foreground">{t("settings.window.blur")}</strong>
                      <p className="mt-1 text-xs text-muted">{t("settings.window.blurDescription")}</p>
                    </div>
                    <output className="text-sm tabular-nums text-muted">{appearance.blur}px</output>
                  </div>
                  <input
                    aria-label={t("settings.window.blur")}
                    className="atlas-slider"
                    max={32}
                    min={0}
                    onChange={(event) => setAppearance({ blur: Number(event.target.value) })}
                    step={1}
                    type="range"
                    value={appearance.blur}
                  />
                </div>
                <label className="atlas-setting-row flex min-h-20 flex-wrap items-center gap-4 p-3">
                  <span className="min-w-0 flex-1">
                    <strong className="text-sm font-medium text-foreground">{t("settings.trayMetric.label")}</strong>
                    <span className="mt-1 block text-xs text-muted">{t("settings.trayMetric.description")}</span>
                  </span>
                  <select
                    aria-label={t("settings.trayMetric.label")}
                    className="atlas-select"
                    onChange={(event) => void onUpdate({
                      advanced: { ...preferences.advanced, trayMetric: event.target.value as DesktopPreferences["advanced"]["trayMetric"] }
                    })}
                    value={preferences.advanced.trayMetric}
                  >
                    {TRAY_METRICS.map((metric) => (
                      <option key={metric} value={metric}>
                        {t(`option.trayMetric.${metric}` as MessageKey)}
                      </option>
                    ))}
                  </select>
                </label>
              </Card.Content>
            </Card>

            <Card variant="transparent">
              <Card.Header>
                <Card.Title>{t("settings.providerColors.title")}</Card.Title>
                <Card.Description>{t("settings.providerColors.description")}</Card.Description>
              </Card.Header>
              <Card.Content className="mt-2">
                <div className="atlas-provider-colors">
                  {providers.map((provider) => (
                    <label className="atlas-provider-color" key={provider.id}>
                      <ProviderLogo mark providerID={provider.id} providerName={provider.name} />
                      <span>{provider.name}</span>
                      <input
                        aria-label={t("settings.providerColors.aria", { provider: provider.name })}
                        onChange={(event) => setAppearance({
                          providerColors: { ...appearance.providerColors, [provider.id]: event.target.value }
                        })}
                        type="color"
                        value={appearance.providerColors[provider.id] ?? "#8e8e93"}
                      />
                      <button
                        aria-label={t("settings.providerColors.reset", { provider: provider.name })}
                        className="atlas-provider-color__reset"
                        onClick={() => {
                          const next = { ...appearance.providerColors };
                          delete next[provider.id];
                          setAppearance({ providerColors: next });
                        }}
                        type="button"
                      >
                        ×
                      </button>
                    </label>
                  ))}
                </div>
              </Card.Content>
            </Card>

            <Card variant="transparent">
              <Card.Header>
                <Card.Title>{t("settings.mark.title")}</Card.Title>
                <Card.Description>{t("settings.mark.description")}</Card.Description>
              </Card.Header>
              <Card.Content className="mt-2">
                <div className="atlas-mark-grid" role="radiogroup" aria-label={t("settings.mark.aria")}>
                  {MARK_OPTIONS.map((option) => (
                    <button
                      aria-checked={appearance.mark === option.id}
                      className="atlas-mark-tile"
                      key={option.id}
                      onClick={() => setAppearance({ mark: option.id })}
                      role="radio"
                      type="button"
                    >
                      <span aria-hidden="true" className="atlas-mark-tile__preview">
                        {markUrls?.[option.id] ? (
                          <img alt="" src={markUrls[option.id]} />
                        ) : null}
                      </span>
                      <span className="atlas-mark-tile__label">{option.label}</span>
                      <span className="atlas-mark-tile__note">
                        {t(`option.mark.${option.id}` as MessageKey)}
                      </span>
                    </button>
                  ))}
                </div>
                <p className="mt-3 text-xs text-muted">{t("settings.mark.restartHint")}</p>
                <Button className="mt-2" onPress={() => void onRestartApp()} variant="outline">
                  {t("settings.mark.restart")}
                </Button>
              </Card.Content>
            </Card>

            <Card variant="transparent">
              <Card.Header>
                <Card.Title>{t("settings.background.title")}</Card.Title>
                <Card.Description>{t("settings.background.description")}</Card.Description>
              </Card.Header>
              <Card.Content className="mt-2">
                <div className="atlas-wallpaper-setting">
                  <RadioGroup
                    className="atlas-wallpaper-options"
                    isDisabled={saving}
                    name="background-image"
                    onChange={(value) => {
                      if (isBackgroundImagePreference(value)) {
                        void onUpdate({ backgroundImage: value });
                      }
                    }}
                    orientation="horizontal"
                    value={
                      preferences.backgroundImage === "custom" && !customBackgroundUrl
                        ? DEFAULT_BACKGROUND_IMAGE
                        : preferences.backgroundImage
                    }
                    variant="secondary"
                  >
                    <Label>{t("settings.background.title")}</Label>
                    {BUILT_IN_WALLPAPERS.map((wallpaper) => (
                      <WallpaperOption
                        key={wallpaper.id}
                        label={wallpaper.label}
                        value={wallpaper.id}
                        wallpaper={wallpaper.id}
                      />
                    ))}
                    {customBackgroundUrl ? (
                      <WallpaperOption
                        label={preferences.customBackgroundName ?? t("option.background.custom")}
                        src={customBackgroundUrl}
                        value="custom"
                      />
                    ) : null}
                  </RadioGroup>
                  <p className="atlas-wallpaper-hint text-xs text-muted">
                    {t("settings.background.hint")}
                  </p>
                  <p
                    className="atlas-wallpaper-error mt-1 text-xs"
                    role="alert"
                  >
                    {backgroundError ?? ""}
                  </p>
                  <div className="atlas-wallpaper-actions">
                    <Button
                      isDisabled={saving}
                      onPress={() => void onChooseCustomBackground()}
                      variant="outline"
                    >
                      {t(customBackgroundUrl ? "settings.background.change" : "settings.background.choose")}
                    </Button>
                  </div>
                </div>
              </Card.Content>
            </Card>
          </div>

          <div className="mt-8" hidden={tab !== "widget"}>
            <SettingsWidget
              onHide={onHideWidget}
              onShow={onShowWidget}
              onUpdate={onUpdate}
              preferences={preferences}
              saving={saving}
            />
          </div>

          <div className="mt-8" hidden={tab !== "data"}>
            <SettingsData
              onChooseExportDirectory={onChooseExportDirectory}
              onChooseFolder={onChooseFolder}
              onExportSettings={onExportSettings}
              onExportUsage={onExportUsage}
              onImportSettings={onImportSettings}
              onUpdate={onUpdate}
              preferences={preferences}
              saving={saving}
            />
          </div>
        </>
      )}
    </div>
  );
}

function WallpaperOption({
  label,
  src,
  value,
  wallpaper
}: {
  label: string;
  src?: string;
  value: BackgroundImagePreference;
  wallpaper?: BuiltInBackgroundId;
}): React.JSX.Element {
  return (
    <Radio className="atlas-wallpaper-option" value={value}>
      <Radio.Content>
        <Radio.Control className="sr-only">
          <Radio.Indicator />
        </Radio.Control>
        <span
          aria-hidden="true"
          className="atlas-wallpaper-option__preview"
          data-wallpaper={wallpaper}
          style={src ? { backgroundImage: `url("${src}")` } : undefined}
        />
        <span className="atlas-wallpaper-option__label">{label}</span>
      </Radio.Content>
    </Radio>
  );
}

export function SettingRow({
  label,
  description,
  checked,
  disabled = false,
  leading,
  status,
  onChange,
}: {
  label: string;
  description: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  leading?: React.ReactNode;
  status?: React.ReactNode;
  onChange(value: boolean): Promise<void>;
}): React.JSX.Element {
  return (
    <div className="atlas-setting-row flex min-h-20 items-center gap-4 p-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {leading}
        <div className="min-w-0">
          <span className="atlas-setting-row__heading">
            <strong className="text-sm font-medium text-foreground">
              {label}
            </strong>
            {status}
          </span>
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

/** The state of a source in one line, with the reconnect step when there is one. */
function ConnectionCopy({
  connection,
}: {
  connection: ProviderConnection;
}): React.JSX.Element {
  return (
    <>
      {connection.summary}
      {connection.action ? (
        <span className="atlas-source-action"> {connection.action}</span>
      ) : null}
      {connection.command ? (
        <code className="atlas-command">{connection.command}</code>
      ) : null}
    </>
  );
}
