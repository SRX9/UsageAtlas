import type { DashboardProvider, DashboardSnapshot } from "@usageatlas/contracts";
import { useEffect, useState } from "react";
import type { DesktopPreferences, WidgetResizeEdge } from "../shared/desktop-api";
import { DEFAULT_WIDGET_PREFERENCES } from "../shared/desktop-api";
import { applyAppearance } from "./appearance";
import { ProviderLogo } from "./components/ProviderLogo";
import { I18nProvider, useI18n } from "./i18n";
import { formatCost, formatExactNumber, formatShortNumber } from "./number-format";

/**
 * The floating mini window's own renderer. Three layouts share one window:
 * `minimal` is the bare token figure, `balanced` adds the active source, and
 * `detailed` adds cost, burn rate and the tightest quota window.
 */
export function CompactWidget(): React.JSX.Element {
  const [preferences, setPreferences] = useState<DesktopPreferences | null>(null);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);

  useEffect(() => {
    let active = true;
    const remove = window.usageAtlas.onSnapshot((state) => {
      if (active) setSnapshot(state.snapshot);
    });
    void Promise.all([window.usageAtlas.getPreferences(), window.usageAtlas.getSnapshot()])
      .then(([nextPreferences, state]) => {
        if (!active) return;
        setPreferences(nextPreferences);
        setSnapshot(state.snapshot);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      remove();
    };
  }, []);

  // The same tick that refreshes usage also reads preferences, so a layout saved
  // in Settings reaches a mini window that is already open.
  useSnapshotRefresh(setSnapshot, setPreferences);

  const appearance = preferences?.appearance;
  useEffect(() => {
    if (appearance) applyAppearance(appearance);
  }, [appearance]);

  return (
    <I18nProvider language={preferences?.language ?? "system"}>
      <WidgetBody
        snapshot={snapshot}
        widget={preferences?.widget ?? DEFAULT_WIDGET_PREFERENCES}
      />
    </I18nProvider>
  );
}

/**
 * The engine serves its cached snapshot, so a refresh is cheap — but a window
 * nobody can see should cost nothing at all. Browsers pause timers of a hidden
 * page only after a while, so this stops its own interval on `visibilitychange`
 * and reads once when the card comes back.
 */
function useSnapshotRefresh(
  setSnapshot: (snapshot: DashboardSnapshot | null) => void,
  setPreferences: (preferences: DesktopPreferences) => void
): void {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const read = (): void => {
      void Promise.all([window.usageAtlas.getSnapshot(), window.usageAtlas.getPreferences()])
        .then(([state, preferences]) => {
          setSnapshot(state.snapshot);
          setPreferences(preferences);
        })
        .catch(() => undefined);
    };
    const start = (): void => {
      if (timer) return;
      read();
      timer = setInterval(read, 30_000);
    };
    const stop = (): void => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };
    const sync = (): void => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [setSnapshot, setPreferences]);
}

/** Below this width the exact figure would wrap, so it becomes `12.4M`. */
const COMPACT_WIDTH = 300;

const RESIZE_EDGES: WidgetResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

function WidgetBody({
  snapshot,
  widget
}: {
  snapshot: DashboardSnapshot | null;
  widget: DesktopPreferences["widget"];
}): React.JSX.Element {
  const { t } = useI18n();
  const [compact, setCompact] = useState(() => window.innerWidth < COMPACT_WIDTH);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 240);

  useEffect(() => {
    const resize = (): void => {
      setCompact(window.innerWidth < COMPACT_WIDTH);
      setNarrow(window.innerWidth < 240);
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  // A drag can end outside the window; releasing the pointer anywhere still
  // stops the main process loop.
  useEffect(() => {
    const stop = (): void => void window.usageAtlas.endWidgetResize();
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
    };
  }, []);

  useAutoHide(widget.autoHideSeconds);

  const style = widget.style;
  const providers = snapshot?.providers.filter((provider) => provider.enabled) ?? [];
  const primary = chooseProvider(providers);
  const totalTokens = providers.reduce(
    (sum, provider) => sum + (provider.analytics?.today.totalTokens ?? 0),
    0
  );
  const cost = providers.reduce<number | null>((sum, provider) => {
    const value = provider.analytics?.today.estimatedCostUSD;
    return value === null || value === undefined ? sum : (sum ?? 0) + value;
  }, null);
  const quota = tightestWindow(primary);
  const burnPerMinute = burnRate(primary);

  return (
    <div
      className="atlas-widget"
      data-compact={compact ? "true" : undefined}
      data-empty={primary ? undefined : "true"}
      data-narrow={narrow ? "true" : undefined}
      data-style={style}
    >
      {style === "minimal" ? (
        <div className="atlas-widget__minimalActions">
          <button
            aria-label={t("widget.hide")}
            className="atlas-widget__button atlas-widget__button--close"
            onClick={() => void window.usageAtlas.hideWidget()}
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 14 14">
              <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
            </svg>
          </button>
        </div>
      ) : (
        <header
          className="atlas-widget__header"
          onDoubleClick={() => void window.usageAtlas.expandWidget()}
          title={t("widget.expandHint")}
        >
          <div className="atlas-widget__identity">
            {primary ? (
              <ProviderLogo compact providerID={primary.id} providerName={primary.name} />
            ) : (
              <span aria-hidden="true" className="atlas-widget__emptyMark">UA</span>
            )}
            <div className="atlas-widget__titles">
              <strong>{primary?.name ?? t("widget.noProvider")}</strong>
              {narrow ? null : <span>{t("widget.tokensToday")}</span>}
            </div>
          </div>
          <div className="atlas-widget__actions">
            <button
              aria-label={t("widget.expand")}
              className="atlas-widget__button"
              onClick={() => void window.usageAtlas.expandWidget()}
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 14 14">
                <path d="M5 2H2v3M9 12h3V9M2 9v3h3M12 5V2H9" />
              </svg>
            </button>
            <button
              aria-label={t("widget.hide")}
              className="atlas-widget__button atlas-widget__button--close"
              onClick={() => void window.usageAtlas.hideWidget()}
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 14 14">
                <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
              </svg>
            </button>
          </div>
        </header>
      )}

      <div className="atlas-widget__tokens" onDoubleClick={() => void window.usageAtlas.expandWidget()}>
        {narrow || style === "minimal" ? null : (
          <span className="atlas-widget__caption">{t("widget.tokensToday")}</span>
        )}
        <div className="atlas-widget__figure">
          <strong data-compact={compact ? "true" : undefined}>
            {compact ? formatShortNumber(totalTokens) : formatExactNumber(totalTokens)}
          </strong>
          <span>{t("widget.tokens")}</span>
        </div>
      </div>

      {style === "detailed" ? (
        <div className="atlas-widget__details">
          <div className="atlas-widget__stat">
            <span>{t("widget.burnRate")}</span>
            <strong>{formatShortNumber(burnPerMinute)}<small>/min</small></strong>
          </div>
          <div className="atlas-widget__stat">
            <span>{t("widget.sessionCost")}</span>
            <strong>{cost === null ? "—" : formatCost(cost)}</strong>
          </div>
          <div className="atlas-widget__quota">
            {quota ? (
              <>
                <div className="atlas-widget__quotaHead">
                  <span>{quota.label}</span>
                  <strong>{Math.round(100 - quota.usedPercent)}% {t("widget.left")}</strong>
                </div>
                <span aria-hidden="true" className="atlas-widget__quotaTrack">
                  <span style={{ width: `${Math.min(100, Math.max(0, 100 - quota.usedPercent))}%` }} />
                </span>
                {quota.resetAt ? (
                  <span className="atlas-widget__reset">
                    {t("widget.reset")} {formatCountdown(quota.resetAt)}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="atlas-widget__reset">{t("widget.noQuota")}</span>
            )}
          </div>
        </div>
      ) : null}

      {RESIZE_EDGES.map((edge) => (
        <span
          aria-hidden="true"
          className="atlas-widget__resize"
          data-edge={edge}
          key={edge}
          onPointerDown={(event) => {
            event.preventDefault();
            // Without capture the pointerup lands outside the window and the
            // main process would keep following the cursor after the drag ends.
            event.currentTarget.setPointerCapture(event.pointerId);
            void window.usageAtlas.beginWidgetResize(edge);
          }}
        />
      ))}
    </div>
  );
}

function chooseProvider(providers: DashboardProvider[]): DashboardProvider | null {
  return providers.reduce<DashboardProvider | null>((best, provider) => {
    const tokens = provider.analytics?.today.totalTokens ?? 0;
    const bestTokens = best?.analytics?.today.totalTokens ?? -1;
    return tokens > bestTokens ? provider : best;
  }, null);
}

/** The window closest to its limit, so the card warns before the roomiest one. */
function tightestWindow(provider: DashboardProvider | null): DashboardProvider["windows"][number] | null {
  if (!provider) return null;
  return provider.windows.reduce<DashboardProvider["windows"][number] | null>(
    (best, window) => (!best || window.usedPercent > best.usedPercent ? window : best),
    null
  );
}

/** Average tokens per minute over the most recent active hour. */
function burnRate(provider: DashboardProvider | null): number {
  const hourly = provider?.analytics?.hourly ?? [];
  const latest = hourly.reduce<number>((max, hour) => Math.max(max, hour.hour), -1);
  if (latest < 0) return 0;
  const tokens = hourly
    .filter((hour) => hour.hour === latest)
    .reduce((sum, hour) => sum + hour.totalTokens, 0);
  return Math.round(tokens / 60);
}

function formatCountdown(resetAt: string): string {
  const remaining = Date.parse(resetAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return "now";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function useAutoHide(seconds: number): void {
  useEffect(() => {
    if (seconds <= 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reset = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void window.usageAtlas.hideWidget(), seconds * 1_000);
    };
    reset();
    window.addEventListener("mousemove", reset);
    window.addEventListener("keydown", reset);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("mousemove", reset);
      window.removeEventListener("keydown", reset);
    };
  }, [seconds]);
}
