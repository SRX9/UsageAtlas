import { Button, Card } from "@heroui/react";
import { useState } from "react";
import type { AdvancedPreferences, DesktopPreferences, ModelCostOverride } from "../../shared/desktop-api";
import { CURRENCY_CODES, EXPORT_SCHEDULES, RETENTION_CHOICES } from "../../shared/desktop-api";
import { useI18n } from "../i18n";
import { SettingRow } from "./Settings";

interface SettingsDataProps {
  preferences: DesktopPreferences;
  saving: boolean;
  onUpdate(patch: Partial<DesktopPreferences>): Promise<void>;
  onExportSettings(): Promise<void>;
  onImportSettings(): Promise<void>;
  onChooseFolder(): Promise<string | null>;
  onChooseExportDirectory(): Promise<string | null>;
  onExportUsage(): Promise<void>;
}

/**
 * Settings → Data. Everything that changes what is collected, how a cost is
 * displayed, and where the resulting history can leave the machine.
 */
export function SettingsData({
  preferences,
  saving,
  onUpdate,
  onExportSettings,
  onImportSettings,
  onChooseFolder,
  onChooseExportDirectory,
  onExportUsage
}: SettingsDataProps): React.JSX.Element {
  const { t } = useI18n();
  const advanced = preferences.advanced;
  const [newLogPath, setNewLogPath] = useState("");
  const [newIgnoredProject, setNewIgnoredProject] = useState("");

  const updateAdvanced = (patch: Partial<AdvancedPreferences>): Promise<void> =>
    onUpdate({ advanced: { ...advanced, ...patch } });

  function addLogPath(): void {
    const value = newLogPath.trim();
    if (!value || advanced.extraLogPaths.includes(value)) return;
    setNewLogPath("");
    void updateAdvanced({ extraLogPaths: [...advanced.extraLogPaths, value] });
  }

  function addIgnoredProject(): void {
    const value = newIgnoredProject.trim();
    if (!value || advanced.ignoredProjects.includes(value)) return;
    setNewIgnoredProject("");
    void updateAdvanced({ ignoredProjects: [...advanced.ignoredProjects, value] });
  }

  function setOverride(index: number, patch: Partial<ModelCostOverride>): void {
    const overrides = advanced.modelCostOverrides.map((override, current) => (
      current === index ? { ...override, ...patch } : override
    ));
    void updateAdvanced({ modelCostOverrides: overrides });
  }

  function removeOverride(index: number): void {
    void updateAdvanced({
      modelCostOverrides: advanced.modelCostOverrides.filter((_, current) => current !== index)
    });
  }

  return (
    <div className="grid gap-5">
      <Card variant="transparent">
        <Card.Header>
          <Card.Title>{t("settings.data.costsTitle")}</Card.Title>
          <Card.Description>{t("settings.data.costsDescription")}</Card.Description>
        </Card.Header>
        <Card.Content className="atlas-settings-list mt-2">
          <label className="atlas-setting-row flex min-h-20 flex-wrap items-center gap-4 p-3">
            <span className="min-w-0 flex-1">
              <strong className="text-sm font-medium text-foreground">{t("settings.data.currency")}</strong>
              <span className="mt-1 block text-xs text-muted">{t("settings.data.currencyDescription")}</span>
            </span>
            <select
              aria-label={t("settings.data.currency")}
              className="atlas-select"
              onChange={(event) => void updateAdvanced({ currency: event.target.value as AdvancedPreferences["currency"] })}
              value={advanced.currency}
            >
              {CURRENCY_CODES.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
            </select>
          </label>
          <NumberRow
            description={t("settings.data.rateDescription")}
            label={t("settings.data.rate")}
            onCommit={(value) => void updateAdvanced({ currencyRate: value })}
            step={0.01}
            value={advanced.currencyRate}
          />
          <NumberRow
            description={t("settings.data.taxDescription")}
            label={t("settings.data.tax")}
            max={100}
            onCommit={(value) => void updateAdvanced({ taxPercent: value })}
            step={0.5}
            value={advanced.taxPercent}
          />
          <NumberRow
            description={t("settings.data.budgetDescription")}
            label={t("settings.data.budget")}
            onCommit={(value) => void updateAdvanced({ monthlyBudgetUSD: value })}
            step={1}
            value={advanced.monthlyBudgetUSD}
          />
        </Card.Content>
      </Card>

      <Card variant="transparent">
        <Card.Header>
          <Card.Title>{t("settings.data.pricingTitle")}</Card.Title>
          <Card.Description>{t("settings.data.pricingDescription")}</Card.Description>
        </Card.Header>
        <Card.Content className="atlas-settings-list mt-2">
          <SettingRow
            checked={advanced.blendedCostEnabled}
            description={t("settings.data.blendedDescription")}
            label={t("settings.data.blended")}
            onChange={(blendedCostEnabled) => updateAdvanced({ blendedCostEnabled })}
          />
          {advanced.blendedCostEnabled ? (
            <NumberRow
              description={t("settings.data.blendedRateDescription")}
              label={t("settings.data.blendedRate")}
              onCommit={(value) => void updateAdvanced({ blendedCostPerMillionUSD: value })}
              step={0.01}
              value={advanced.blendedCostPerMillionUSD}
            />
          ) : null}
          <SettingRow
            checked={advanced.promptCaching}
            description={t("settings.data.cachingDescription")}
            label={t("settings.data.caching")}
            onChange={(promptCaching) => updateAdvanced({ promptCaching })}
          />
          <div className="px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <strong className="text-sm font-medium text-foreground">{t("settings.data.overridesTitle")}</strong>
                <p className="mt-1 text-xs text-muted">{t("settings.data.overridesDescription")}</p>
              </div>
              <Button
                isDisabled={saving || advanced.modelCostOverrides.length >= 50}
                onPress={() => void updateAdvanced({
                  modelCostOverrides: [...advanced.modelCostOverrides, {
                    model: "", input: 0, output: 0, cacheRead: null, cacheWrite: null
                  }]
                })}
                variant="outline"
              >
                {t("settings.data.addOverride")}
              </Button>
            </div>
            {advanced.modelCostOverrides.length > 0 ? (
              <div className="mt-3 grid gap-2">
                {advanced.modelCostOverrides.map((override, index) => (
                  <div className="atlas-override-row" key={`${override.model}-${index}`}>
                    <input
                      aria-label={t("settings.data.overrideModel")}
                      className="atlas-text-field"
                      defaultValue={override.model}
                      onBlur={(event) => setOverride(index, { model: event.target.value.trim() })}
                      placeholder={t("settings.data.overrideModelPlaceholder")}
                    />
                    <NumberInput
                      ariaLabel={t("settings.data.overrideInput")}
                      onCommit={(value) => setOverride(index, { input: value })}
                      value={override.input}
                    />
                    <NumberInput
                      ariaLabel={t("settings.data.overrideOutput")}
                      onCommit={(value) => setOverride(index, { output: value })}
                      value={override.output}
                    />
                    <Button onPress={() => removeOverride(index)} size="sm" variant="ghost">
                      {t("settings.data.remove")}
                    </Button>
                  </div>
                ))}
                <p className="text-xs text-muted">{t("settings.data.overrideUnits")}</p>
              </div>
            ) : null}
          </div>
        </Card.Content>
      </Card>

      <Card variant="transparent">
        <Card.Header>
          <Card.Title>{t("settings.data.collectionTitle")}</Card.Title>
          <Card.Description>{t("settings.data.collectionDescription")}</Card.Description>
        </Card.Header>
        <Card.Content className="atlas-settings-list mt-2">
          <div className="px-3 py-3">
            <strong className="text-sm font-medium text-foreground">{t("settings.data.logPathsTitle")}</strong>
            <p className="mt-1 text-xs text-muted">{t("settings.data.logPathsDescription")}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                aria-label={t("settings.data.logPathsTitle")}
                className="atlas-text-field min-w-0 flex-1"
                onChange={(event) => setNewLogPath(event.target.value)}
                placeholder={t("settings.data.logPathPlaceholder")}
                value={newLogPath}
              />
              <Button onPress={addLogPath} variant="outline">{t("settings.data.add")}</Button>
              <Button
                onPress={() => void onChooseFolder().then((folder) => {
                  if (folder && !advanced.extraLogPaths.includes(folder)) {
                    void updateAdvanced({ extraLogPaths: [...advanced.extraLogPaths, folder] });
                  }
                })}
                variant="ghost"
              >
                {t("settings.data.browse")}
              </Button>
            </div>
            <PathList
              empty={t("settings.data.noPaths")}
              onRemove={(path) => void updateAdvanced({
                extraLogPaths: advanced.extraLogPaths.filter((value) => value !== path)
              })}
              paths={advanced.extraLogPaths}
            />
          </div>
          <div className="px-3 py-3">
            <strong className="text-sm font-medium text-foreground">{t("settings.data.ignoredTitle")}</strong>
            <p className="mt-1 text-xs text-muted">{t("settings.data.ignoredDescription")}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                aria-label={t("settings.data.ignoredTitle")}
                className="atlas-text-field min-w-0 flex-1"
                onChange={(event) => setNewIgnoredProject(event.target.value)}
                placeholder={t("settings.data.ignoredPlaceholder")}
                value={newIgnoredProject}
              />
              <Button onPress={addIgnoredProject} variant="outline">{t("settings.data.add")}</Button>
            </div>
            <PathList
              empty={t("settings.data.noPaths")}
              onRemove={(path) => void updateAdvanced({
                ignoredProjects: advanced.ignoredProjects.filter((value) => value !== path)
              })}
              paths={advanced.ignoredProjects}
            />
          </div>
          <NumberRow
            description={t("settings.data.staleDescription")}
            label={t("settings.data.stale")}
            max={10_080}
            onCommit={(value) => void updateAdvanced({ staleSessionMinutes: value })}
            step={5}
            value={advanced.staleSessionMinutes}
          />
        </Card.Content>
      </Card>

      <Card variant="transparent">
        <Card.Header>
          <Card.Title>{t("settings.data.privacyTitle")}</Card.Title>
          <Card.Description>{t("settings.data.privacyDescription")}</Card.Description>
        </Card.Header>
        <Card.Content className="atlas-settings-list mt-2">
          <SettingRow
            checked={advanced.redactProjects}
            description={t("settings.data.redactDescription")}
            label={t("settings.data.redact")}
            onChange={(redactProjects) => updateAdvanced({ redactProjects })}
          />
          <label className="atlas-setting-row flex min-h-20 flex-wrap items-center gap-4 p-3">
            <span className="min-w-0 flex-1">
              <strong className="text-sm font-medium text-foreground">{t("settings.data.retention")}</strong>
              <span className="mt-1 block text-xs text-muted">{t("settings.data.retentionDescription")}</span>
            </span>
            <select
              aria-label={t("settings.data.retention")}
              className="atlas-select"
              onChange={(event) => void updateAdvanced({ retentionDays: Number(event.target.value) })}
              value={advanced.retentionDays}
            >
              {RETENTION_CHOICES.map((days) => (
                <option key={days} value={days}>
                  {days === 0 ? t("settings.data.keepForever") : t("settings.data.days", { count: days })}
                </option>
              ))}
            </select>
          </label>
          <label className="atlas-setting-row flex min-h-20 flex-wrap items-center gap-4 p-3">
            <span className="min-w-0 flex-1">
              <strong className="text-sm font-medium text-foreground">{t("settings.data.schedule")}</strong>
              <span className="mt-1 block text-xs text-muted">{t("settings.data.scheduleDescription")}</span>
            </span>
            <select
              aria-label={t("settings.data.schedule")}
              className="atlas-select"
              onChange={(event) => void updateAdvanced({ exportSchedule: event.target.value as AdvancedPreferences["exportSchedule"] })}
              value={advanced.exportSchedule}
            >
              {EXPORT_SCHEDULES.map((schedule) => (
                <option key={schedule} value={schedule}>{t(`settings.data.schedule.${schedule}` as Parameters<typeof t>[0])}</option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap items-center gap-2 px-3 py-3">
            <span className="min-w-0 flex-1 text-xs text-muted">
              {advanced.exportDirectory ?? t("settings.data.noExportDirectory")}
            </span>
            <Button onPress={() => void onChooseExportDirectory()} variant="outline">
              {t("settings.data.chooseFolder")}
            </Button>
          </div>
          <SettingRow
            checked={advanced.encryptExports}
            description={t("settings.data.encryptDescription")}
            label={t("settings.data.encrypt")}
            onChange={(encryptExports) => updateAdvanced({ encryptExports })}
          />
          <div className="flex flex-wrap items-center gap-2 px-3 py-3">
            <Button isDisabled={saving} onPress={() => void onExportUsage()} variant="secondary">
              {t("settings.data.exportUsage")}
            </Button>
            <Button isDisabled={saving} onPress={() => void onExportSettings()} variant="outline">
              {t("settings.data.exportSettings")}
            </Button>
            <Button isDisabled={saving} onPress={() => void onImportSettings()} variant="outline">
              {t("settings.data.importSettings")}
            </Button>
          </div>
        </Card.Content>
      </Card>
    </div>
  );
}

function PathList({
  empty,
  paths,
  onRemove
}: {
  empty: string;
  paths: string[];
  onRemove(path: string): void;
}): React.JSX.Element {
  if (paths.length === 0) return <p className="mt-2 text-xs text-muted">{empty}</p>;
  return (
    <ul className="mt-3 grid gap-1">
      {paths.map((path) => (
        <li className="atlas-path-row" key={path}>
          <code>{path}</code>
          <button aria-label={`Remove ${path}`} onClick={() => onRemove(path)} type="button">×</button>
        </li>
      ))}
    </ul>
  );
}

function NumberRow({
  label,
  description,
  value,
  step,
  max,
  onCommit
}: {
  label: string;
  description: string;
  value: number;
  step: number;
  max?: number;
  onCommit(value: number): void;
}): React.JSX.Element {
  return (
    <label className="atlas-setting-row flex min-h-20 flex-wrap items-center gap-4 p-3">
      <span className="min-w-0 flex-1">
        <strong className="text-sm font-medium text-foreground">{label}</strong>
        <span className="mt-1 block text-xs text-muted">{description}</span>
      </span>
      <NumberInput ariaLabel={label} max={max} onCommit={onCommit} step={step} value={value} />
    </label>
  );
}

function NumberInput({
  ariaLabel,
  value,
  step = 1,
  max,
  onCommit
}: {
  ariaLabel: string;
  value: number;
  step?: number;
  max?: number;
  onCommit(value: number): void;
}): React.JSX.Element {
  return (
    <input
      aria-label={ariaLabel}
      className="atlas-number-field"
      defaultValue={value}
      max={max}
      min={0}
      onBlur={(event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onCommit(Math.max(0, max === undefined ? next : Math.min(max, next)));
      }}
      step={step}
      type="number"
    />
  );
}
