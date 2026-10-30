import { Button, Card, Input, Label, Skeleton, Spinner, Switch, TextField } from "@heroui/react";
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { DashboardProvider, DashboardWindow } from "@usageatlas/contracts";
import type { DesktopAlertInboxEntry, DesktopPreferences, TokenAlertPreferences, UsageAlertRule } from "../../shared/desktop-api";
import { DEFAULT_USAGE_ALERT_THRESHOLD } from "../../shared/usage-alerts";
import { formatReset } from "../dashboard-model";
import { AlertIcon, BellIcon, CheckIcon } from "../icons";
import { useI18n } from "../i18n";
import { ProviderLogo } from "./ProviderLogo";
import { UsageAlertDelivery } from "./UsageAlertDelivery";

interface UsageAlertsPageProps {
  preferences: DesktopPreferences | null;
  providers: DashboardProvider[];
  saving: boolean;
  onUpdate: (patch: Partial<DesktopPreferences>) => Promise<void>;
  /** Every alert this window has received, newest first. */
  notifications?: DesktopAlertInboxEntry[];
  onClearNotifications?: () => void;
  /** Shows a real desktop notification so the user can confirm it arrives. */
  onTestAlert?: (tokens: number, providerName: string) => Promise<boolean>;
}

interface UsageAlertWindowCardProps {
  provider: DashboardProvider;
  window: DashboardWindow;
  rule: UsageAlertRule;
  sourceDisabled: boolean;
  onChange: (rule: UsageAlertRule) => Promise<void>;
}

interface CircularThresholdPickerProps {
  value: number;

  disabled?: boolean;
  label: string;
  onChange: (value: number) => Promise<void>;
}

export function UsageAlertsPage({
  notifications = [],
  onClearNotifications,
  preferences,
  providers,
  saving,
  onUpdate,
  onTestAlert,
}: UsageAlertsPageProps) {
  const meteredProviders = providers.filter((provider) => provider.windows.length > 0);
  const { t } = useI18n();
  const windowCount = meteredProviders.reduce((total, provider) => total + provider.windows.length, 0);
  const tokenAlerts = preferences?.tokenAlerts ?? { enabled: true, thresholdTokens: 100_000 };
  const sampleProvider = providers.find((provider) => provider.enabled)?.name ?? "Freebuff";
  const sampleTokens = Math.max(tokenAlerts.thresholdTokens, 12_400);
  const activeAlertCount = preferences
    ? meteredProviders.reduce(
        (total, provider) =>
          provider.enabled
            ? total +
              provider.windows.filter(
                (window) => preferences.usageAlerts[provider.id]?.[window.kind]?.enabled,
              ).length
            : total,
        0,
      )
    : 0;

  async function updateRule(
    providerId: string,
    windowKind: DashboardWindow["kind"],
    nextRule: UsageAlertRule,
  ) {
    if (!preferences) {
      return;
    }

    await onUpdate({
      usageAlerts: {
        ...preferences.usageAlerts,
        [providerId]: {
          ...preferences.usageAlerts[providerId],
          [windowKind]: nextRule,
        },
      },
    });
  }

  return (
    <div className="atlas-page atlas-alerts-page">
      <header className="atlas-page__header atlas-alerts-page__header">
        <div>
          <p className="atlas-page__kicker">{t("alerts.kicker")}</p>
          <h1>{t("alerts.title")}</h1>
          <p>{t("alerts.description")}</p>
        </div>
        <div className="atlas-alerts-page__save-status" role="status" aria-live="polite">
          {saving ? (
            <>
              <Spinner size="sm" />
              <span>{t("alerts.saving")}</span>
            </>
          ) : (
            <span>{t("alerts.autosave")}</span>
          )}
        </div>
      </header>

      <Card className="atlas-alert-inbox" variant="transparent">
        <Card.Header>
          <Card.Title>{t("alerts.inbox.title")}</Card.Title>
          <Card.Description>{t("alerts.inbox.description")}</Card.Description>
        </Card.Header>
        <Card.Content>
          {notifications.length === 0 ? (
            <p className="atlas-alert-inbox__empty">{t("alerts.inbox.empty")}</p>
          ) : (
            <ul className="atlas-alert-inbox__list">
              {notifications.map((notification) => (
                <li key={`${notification.receivedAt}-${notification.title}`} className="atlas-alert-inbox__item">
                  <div className="atlas-alert-inbox__head">
                    <strong>{notification.title}</strong>
                    <time dateTime={notification.receivedAt}>
                      {new Date(notification.receivedAt).toLocaleString()}
                    </time>
                  </div>
                  <p>{notification.body}</p>
                </li>
              ))}
            </ul>
          )}
          {notifications.length > 0 && onClearNotifications ? (
            <Button onPress={onClearNotifications} size="sm" variant="ghost">
              {t("alerts.inbox.clear")}
            </Button>
          ) : null}
        </Card.Content>
      </Card>

      {!preferences ? (
        <AlertsPageSkeleton />
      ) : (
        <>
          <TokenAlertCard
            onTestAlert={onTestAlert}
            onUpdate={onUpdate}
            sampleProvider={sampleProvider}
            sampleTokens={sampleTokens}
            tokenAlerts={tokenAlerts}
          />
          <UsageAlertDelivery onUpdate={onUpdate} preferences={preferences} />
          {meteredProviders.length === 0 ? (
            <Card className="atlas-alerts-empty" variant="transparent">
              <Card.Content>
                <BellIcon aria-hidden />
                <h2>{t("alerts.capacity.emptyTitle")}</h2>
                <p>{t("alerts.capacity.emptyBody")}</p>
              </Card.Content>
            </Card>
          ) : null}
          {meteredProviders.length > 0 ? (
        <>
          <Card className="atlas-alerts-overview" variant="transparent">
            <Card.Content>
              <div className="atlas-alerts-overview__intro">
                <div className="atlas-alerts-overview__icon" aria-hidden>
                  <BellIcon />
                </div>
                <div>
                  <h2>{t("alerts.overview.title")}</h2>
                  <p>{t("alerts.overview.description")}</p>
                </div>
              </div>
              <dl className="atlas-alerts-overview__metrics">
                <div>
                  <dt>{t("alerts.overview.active")}</dt>
                  <dd>{activeAlertCount}</dd>
                </div>
                <div>
                  <dt>{t("alerts.overview.windows")}</dt>
                  <dd>{windowCount}</dd>
                </div>
              </dl>
            </Card.Content>
          </Card>

          <div className="atlas-alert-provider-list">
            {meteredProviders.map((provider) => (
              <section
                className="atlas-alert-provider-section"
                aria-labelledby={`alerts-provider-${provider.id}`}
                key={provider.id}
              >
                <div className="atlas-alert-provider-section__heading">
                  <div className="atlas-alert-provider-section__identity">
                    <ProviderLogo providerID={provider.id} providerName={provider.name} />
                    <div>
                      <h2 id={`alerts-provider-${provider.id}`}>{provider.name}</h2>
                      <p>{provider.enabled ? (provider.identity?.plan ?? "Usage monitoring available") : "Source disabled"}</p>
                    </div>
                  </div>
                  <span
                    className="atlas-alert-source-status"
                    data-tone={provider.enabled ? "positive" : "neutral"}
                  >
                    {provider.enabled ? <CheckIcon /> : <AlertIcon />}
                    <span>{t(provider.enabled ? "alerts.connected" : "alerts.disabled")}</span>
                  </span>
                </div>

                <div className="atlas-alert-window-grid">
                  {provider.windows.map((window) => {
                    const rule = preferences.usageAlerts[provider.id]?.[window.kind] ?? {
                      enabled: false,
                      thresholdPercent: DEFAULT_USAGE_ALERT_THRESHOLD,
                    };

                    return (
                      <UsageAlertWindowCard
                        key={window.kind}
                        provider={provider}
                        window={window}
                        rule={rule}
                        sourceDisabled={!provider.enabled}
                        onChange={(nextRule) => updateRule(provider.id, window.kind, nextRule)}
                      />
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * The alert that works for every source: a daily token count, announced with the
 * exact number and the provider name. No quota window is required, so private
 * and unofficial providers are covered too.
 */
function TokenAlertCard({
  tokenAlerts,
  sampleProvider,
  sampleTokens,
  onUpdate,
  onTestAlert,
}: {
  tokenAlerts: TokenAlertPreferences;
  sampleProvider: string;
  sampleTokens: number;
  onUpdate: (patch: Partial<DesktopPreferences>) => Promise<void>;
  onTestAlert?: (tokens: number, providerName: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(String(tokenAlerts.thresholdTokens));
  const [tested, setTested] = useState<string | null>(null);
  const commit = (raw: string): void => {
    const parsed = Number(raw.replace(/[^0-9]/gu, ""));
    if (!Number.isFinite(parsed) || parsed < 1_000) {
      setDraft(String(tokenAlerts.thresholdTokens));
      return;
    }
    const thresholdTokens = Math.min(1_000_000_000, Math.round(parsed));
    setDraft(String(thresholdTokens));
    if (thresholdTokens !== tokenAlerts.thresholdTokens) {
      void onUpdate({ tokenAlerts: { ...tokenAlerts, thresholdTokens } });
    }
  };

  return (
    <Card className="atlas-token-alert" variant="transparent">
      <Card.Header>
        <div className="atlas-token-alert__heading">
          <div>
            <Card.Title>{t("alerts.daily.title")}</Card.Title>
            <Card.Description>{t("alerts.daily.description")}</Card.Description>
          </div>
          <Switch
            aria-label={t("alerts.daily.switch")}
            isSelected={tokenAlerts.enabled}
            onChange={(enabled) => void onUpdate({ tokenAlerts: { ...tokenAlerts, enabled } })}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
        </div>
      </Card.Header>
      <Card.Content>
        <div className="atlas-token-alert__body">
          <TextField isDisabled={!tokenAlerts.enabled}>
            <Label>{t("alerts.daily.after")}</Label>
            <Input
              inputMode="numeric"
              onBlur={(event) => commit(event.target.value)}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commit(event.currentTarget.value);
              }}
              value={draft}
            />
          </TextField>
          <p className="atlas-token-alert__unit">{t("alerts.daily.unit")}</p>
          <div className="atlas-token-alert__sample">
            <span>{t("alerts.daily.preview")}</span>
            <strong>{t("alerts.daily.message", { tokens: formatTokens(sampleTokens), provider: sampleProvider })}</strong>
          </div>
          {onTestAlert ? (
            <Button
              onPress={async () => {
                const shown = await onTestAlert(sampleTokens, sampleProvider);
                setTested(t(shown ? "alerts.daily.sent" : "alerts.daily.unavailable"));
              }}
              variant="outline"
            >
              <BellIcon />
              <span>{t("alerts.daily.test")}</span>
            </Button>
          ) : null}
          <p aria-live="polite" className="atlas-token-alert__status">{tested ?? ""}</p>
        </div>
      </Card.Content>
    </Card>
  );
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function UsageAlertWindowCard({
  provider,
  window,
  rule,
  sourceDisabled,
  onChange,
}: UsageAlertWindowCardProps) {
  const { t } = useI18n();
  const thresholdReached = rule.enabled && window.remainingPercent <= rule.thresholdPercent;
  const status = sourceDisabled
    ? { label: t("alerts.sourceDisabled"), tone: "neutral" }
    : !rule.enabled
      ? { label: t("alerts.alertOff"), tone: "neutral" }
      : thresholdReached
        ? { label: t("alerts.thresholdReached"), tone: "warning" }
        : { label: t("alerts.watching"), tone: "positive" };

  return (
    <Card className="atlas-alert-window-card" data-enabled={rule.enabled}>
      <Card.Header>
        <div>
          <Card.Title>{window.label}</Card.Title>
          <Card.Description>{formatReset(window)}</Card.Description>
        </div>
        <Switch
          aria-label={`${provider.name} ${window.label} usage alert`}
          isSelected={rule.enabled}
          isDisabled={sourceDisabled}
          onChange={(enabled) => void onChange({ ...rule, enabled })}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
      </Card.Header>
      <Card.Content>
        <CircularThresholdPicker
          label={`${provider.name} ${window.label} alert threshold`}
          value={rule.thresholdPercent}

          disabled={sourceDisabled}
          onChange={(thresholdPercent) => onChange({ ...rule, thresholdPercent })}
        />

        <div className="atlas-alert-window-card__details">
          <span className="atlas-alert-rule-status" data-tone={status.tone}>
            <span aria-hidden />
            {status.label}
          </span>
          <div className="atlas-alert-rule-copy">
            <p className="atlas-alert-rule-copy__eyebrow">{t("alerts.rule")}</p>
            <p>
              {rule.enabled
                ? t("alerts.ruleOn", { percent: rule.thresholdPercent })
                : t("alerts.ruleOff")}
            </p>
          </div>
          <div className="atlas-alert-current-capacity">
            <span>{t("alerts.capacity")}</span>
            <strong>{formatPercent(window.remainingPercent)}%</strong>
          </div>
        </div>
      </Card.Content>
    </Card>
  );
}

function CircularThresholdPicker({
  value,

  disabled = false,
  label,
  onChange,
}: CircularThresholdPickerProps) {
  const [draft, setDraft] = useState(value);
  const dragging = useRef(false);
  const gradientId = useId().replace(/:/g, "");
  const radius = 82;
  const center = 110;
  const angle = 135 + (draft / 100) * 270;
  const radians = (angle * Math.PI) / 180;
  const handleX = center + radius * Math.cos(radians);
  const handleY = center + radius * Math.sin(radians);

  function valueFromPointer(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - (rect.left + rect.width / 2);
    const y = event.clientY - (rect.top + rect.height / 2);
    let angleFromEast = (Math.atan2(y, x) * 180) / Math.PI;

    if (angleFromEast < 0) {
      angleFromEast += 360;
    }

    let relativeAngle = angleFromEast - 135;
    if (relativeAngle < 0) {
      relativeAngle += 360;
    }

    if (relativeAngle > 270) {
      relativeAngle = relativeAngle < 315 ? 270 : 0;
    }

    return clamp(Math.round((relativeAngle / 270) * 100), 0, 100);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (disabled) {
      return;
    }

    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = true;
    setDraft(valueFromPointer(event));
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragging.current || disabled) {
      return;
    }

    setDraft(valueFromPointer(event));
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!dragging.current || disabled) {
      return;
    }

    const nextValue = valueFromPointer(event);
    dragging.current = false;
    setDraft(nextValue);
    event.currentTarget.releasePointerCapture(event.pointerId);

    if (nextValue !== value) {
      void onChange(nextValue);
    }
  }

  function handlePointerCancel() {
    dragging.current = false;
    setDraft(value);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled) {
      return;
    }

    let nextValue: number;
    switch (event.key) {
      case "ArrowUp":
      case "ArrowRight":
        nextValue = draft + 1;
        break;
      case "ArrowDown":
      case "ArrowLeft":
        nextValue = draft - 1;
        break;
      case "PageUp":
        nextValue = draft + 10;
        break;
      case "PageDown":
        nextValue = draft - 10;
        break;
      case "Home":
        nextValue = 0;
        break;
      case "End":
        nextValue = 100;
        break;
      default:
        return;
    }

    event.preventDefault();
    const clampedValue = clamp(nextValue, 0, 100);
    setDraft(clampedValue);
    void onChange(clampedValue);
  }

  return (
    <div className="atlas-threshold-control">
      <div
        className="atlas-threshold-dial"
        data-disabled={disabled || undefined}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={draft}
        aria-valuetext={`${draft}% remaining`}
        aria-disabled={disabled || undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onKeyDown={handleKeyDown}
      >
        <svg viewBox="0 0 220 220" aria-hidden>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--accent)" />
              <stop offset="100%" stopColor="var(--success)" />
            </linearGradient>
          </defs>
          <circle
            className="atlas-threshold-dial__track"
            cx={center}
            cy={center}
            r={radius}
            pathLength="100"
            transform={`rotate(135 ${center} ${center})`}
          />
          <circle
            className="atlas-threshold-dial__progress"
            cx={center}
            cy={center}
            r={radius}
            pathLength="100"
            stroke={`url(#${gradientId})`}
            strokeDasharray={`${draft * 0.75} 100`}
            transform={`rotate(135 ${center} ${center})`}
          />
          <circle
            className="atlas-threshold-dial__handle-halo"
            cx={handleX}
            cy={handleY}
            r="13"
          />
          <circle
            className="atlas-threshold-dial__handle"
            cx={handleX}
            cy={handleY}
            r="7"
          />
        </svg>
        <div className="atlas-threshold-dial__value" aria-hidden>
          <strong>{draft}</strong>
          <span>% remaining</span>
        </div>
        <span className="atlas-threshold-dial__minimum" aria-hidden>
          0
        </span>
        <span className="atlas-threshold-dial__maximum" aria-hidden>
          100
        </span>
      </div>
      <p>
        Drag the meter or use arrow keys to fine-tune the threshold.
      </p>
    </div>
  );
}

function AlertsPageSkeleton() {
  return (
    <div className="atlas-alerts-skeleton" aria-label="Loading usage alerts">
      <Card variant="transparent">
        <Card.Content>
          <Skeleton className="atlas-alerts-skeleton__heading" />
          <Skeleton className="atlas-alerts-skeleton__line" />
        </Card.Content>
      </Card>
      <div className="atlas-alert-window-grid">
        {[0, 1].map((item) => (
          <Card key={item}>
            <Card.Content>
              <Skeleton className="atlas-alerts-skeleton__dial" />
              <Skeleton className="atlas-alerts-skeleton__line" />
            </Card.Content>
          </Card>
        ))}
      </div>
    </div>
  );
}

function formatPercent(value: number) {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
