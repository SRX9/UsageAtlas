import { Card } from "@heroui/react";
import type { AdvancedPreferences, DesktopPreferences } from "../../shared/desktop-api";
import { useI18n } from "../i18n";
import { SettingRow } from "./Settings";

/**
 * Delivery rules that apply to every alert: how fast is too fast, how close to a
 * quota reset is worth a warning, and whether the toast should make a sound.
 */
export function UsageAlertDelivery({
  preferences,
  onUpdate
}: {
  preferences: DesktopPreferences;
  onUpdate(patch: Partial<DesktopPreferences>): Promise<void>;
}): React.JSX.Element {
  const { t } = useI18n();
  const advanced = preferences.advanced;
  const update = (patch: Partial<AdvancedPreferences>): Promise<void> =>
    onUpdate({ advanced: { ...advanced, ...patch } });

  return (
    <Card className="atlas-alert-delivery" variant="transparent">
      <Card.Header>
        <Card.Title>{t("alerts.delivery.title")}</Card.Title>
        <Card.Description>{t("alerts.delivery.description")}</Card.Description>
      </Card.Header>
      <Card.Content className="atlas-settings-list">
        <SettingRow
          checked={advanced.burnRateEnabled}
          description={t("alerts.delivery.burnDescription")}
          label={t("alerts.delivery.burn")}
          onChange={(burnRateEnabled) => update({ burnRateEnabled })}
        />
        {advanced.burnRateEnabled ? (
          <div className="atlas-alert-delivery__fields">
            <label>
              <span>{t("alerts.delivery.burnTokens")}</span>
              <input
                className="atlas-number-field"
                defaultValue={advanced.burnRateTokensPerMinute}
                min={1_000}
                onBlur={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value) && value >= 1_000) void update({ burnRateTokensPerMinute: Math.round(value) });
                }}
                step={1_000}
                type="number"
              />
            </label>
            <label>
              <span>{t("alerts.delivery.burnCost")}</span>
              <input
                className="atlas-number-field"
                defaultValue={advanced.burnRateUSDPerMinute}
                min={0.01}
                onBlur={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value) && value > 0) void update({ burnRateUSDPerMinute: value });
                }}
                step={0.5}
                type="number"
              />
            </label>
          </div>
        ) : null}
        <SettingRow
          checked={advanced.resetCountdownEnabled}
          description={t("alerts.delivery.resetDescription")}
          label={t("alerts.delivery.reset")}
          onChange={(resetCountdownEnabled) => update({ resetCountdownEnabled })}
        />
        {advanced.resetCountdownEnabled ? (
          <div className="atlas-alert-delivery__fields">
            <label>
              <span>{t("alerts.delivery.resetMinutes")}</span>
              <input
                className="atlas-number-field"
                defaultValue={advanced.resetCountdownMinutes}
                max={240}
                min={1}
                onBlur={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value) && value >= 1 && value <= 240) void update({ resetCountdownMinutes: Math.round(value) });
                }}
                step={5}
                type="number"
              />
            </label>
          </div>
        ) : null}
        <SettingRow
          checked={advanced.dnd}
          description={t("alerts.delivery.dndDescription")}
          label={t("alerts.delivery.dnd")}
          onChange={(dnd) => update({ dnd })}
        />
        <SettingRow
          checked={advanced.notifyLogErrors}
          description={t("alerts.delivery.logErrorsDescription")}
          label={t("alerts.delivery.logErrors")}
          onChange={(notifyLogErrors) => update({ notifyLogErrors })}
        />
        <SettingRow
          checked={advanced.notificationSounds}
          description={t("alerts.delivery.soundsDescription")}
          label={t("alerts.delivery.sounds")}
          onChange={(notificationSounds) => update({ notificationSounds })}
        />
      </Card.Content>
    </Card>
  );
}
